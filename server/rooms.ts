import type { Server } from 'socket.io';
import { buildDeck, getLeaders } from '../src/utils/coreGameEngine';
import { getEffectiveTurnDuration } from '../src/utils/turnDuration';
import {
  DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE, DEFAULT_TURN_DURATION, DEFAULT_RECONNECT_TIMEOUT,
} from '../src/utils/configValidation';
import type { Room, RoomState, ServerPlayer } from './roomTypes';

export const rooms: Record<string, Room> = {};

// Upper bound on distinct players a single room can hold. Without one, a
// hostile or buggy client could keep joining new deviceIds into one room
// forever, growing its player/chart arrays (and every broadcast of them)
// without limit — this is a sanity cap on room size, not a real gameplay
// scenario (nobody plays Tutto with anywhere near this many players).
export const MAX_PLAYERS_PER_ROOM = 100;

// Upper bound on concurrently existing rooms. joinRoom refuses to CREATE a
// room past this cap (joins and reconnects into existing rooms are
// unaffected). Without it, a scripted client cycling join → hard-disconnect
// leaves ghost rooms alive for up to reconnectTimeout seconds each, growing
// `rooms` — and the O(rooms) one-device-one-room scan every join pays —
// without bound. Far above any realistic concurrent-game count.
export const MAX_ROOMS = 500;

export const createRoom = (hostSocketId: string): Room => ({
  host: hostSocketId,
  gameActualStartTime: null,
  turnTimerState: null,
  disconnectTimers: {},
  turnExpireTimer: null,
  statsRecordedForGame: { devices: new Set(), global: false },
  state: {
    players: [],
    status: 'lobby',
    initialCards: { ...DEFAULT_INITIAL_CARDS },
    winningScore: DEFAULT_WINNING_SCORE,
    randomOrder: true,
    turnDuration: DEFAULT_TURN_DURATION,
    reconnectTimeout: DEFAULT_RECONNECT_TIMEOUT,
    currentCard: null,
    cards: [],
    round: 1,
    currentPlayerIndex: null,
    finished: false,
    chartValues: [],
    chartNames: [],
    chartLabels: [],
    gameTimeInSeconds: 0,
    turnStartTime: null,
    previousCard: null,
    previousScore: null,
    previousLeaders: null,
    previousWasBust: false,
    previousHighestTurnScore: 0,
    previousHighestFeuerwerkTurnScore: 0,
    previousHighestX2TurnScore: 0,
    previousPlayerName: null,
    liveTurnState: null,
    enforcedDiceMode: null,
    historyLog: [],
  },
});

// Every room-deletion site must go through this, not a bare `delete rooms[id]`.
// A pending disconnect-timeout timer (armed in socketHandlers.handlePlayerLeave)
// captures roomId in its closure and looks the room up fresh, by id, when it
// fires — so if the room was deleted without cancelling it, and a NEW room is
// later created under the same id (e.g. the disconnected player reconnects and
// recreates it), the stale timer fires against that unrelated new room and can
// evict a player from it, or delete it outright.
export const deleteRoom = (roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  if (room.turnExpireTimer) clearTimeout(room.turnExpireTimer);
  Object.values(room.disconnectTimers).forEach(timer => clearTimeout(timer));
  delete rooms[roomId];
};

export const drawNextCardForRoom = (state: RoomState): void => {
  if (state.cards && state.cards.length > 0) {
    state.currentCard = state.cards.shift() ?? null;
  } else {
    const deck = buildDeck(state.initialCards);
    state.currentCard = deck.shift() ?? null;
    state.cards = deck;
  }
};

export const handleActivePlayerRemoved = (room: Room, removedIdx: number): void => {
  const state = room.state;
  // chartValues/chartNames are player-indexed (one entry per player), so the
  // removed player's slot is spliced out of both. chartLabels is NOT spliced
  // here — it's round-indexed (one entry per completed round, shared across
  // all players), so a player leaving never removes an entry from it.
  if (Array.isArray(state.chartValues) && removedIdx < state.chartValues.length) {
    state.chartValues.splice(removedIdx, 1);
  }
  if (Array.isArray(state.chartNames) && removedIdx < state.chartNames.length) {
    state.chartNames.splice(removedIdx, 1);
  }

  if (state.currentPlayerIndex === null) return;
  const curIdx = state.currentPlayerIndex;
  if (removedIdx < curIdx) {
    state.currentPlayerIndex = curIdx - 1;
  } else if (removedIdx === curIdx) {
    // `state.players` has already been spliced by the caller, so its length here
    // is the original turn-order size minus one. The removed player was the last
    // to act this round only if their index equals that post-splice length —
    // otherwise players after them still owe a turn this round, and jumping the
    // round forward would skip those turns entirely.
    const removedPlayerWasLastInOrder = removedIdx === state.players.length;
    state.currentPlayerIndex = curIdx % Math.max(1, state.players.length);
    state.previousCard = null;
    state.previousScore = null;
    state.previousLeaders = null;
    state.previousPlayerName = null;
    // The removed player was mid-turn — drop their live dice snapshot so
    // spectators don't keep seeing it attributed to the player now in this slot.
    state.liveTurnState = null;
    let isGameOver = false;
    if (removedPlayerWasLastInOrder) {
      // Same bookkeeping calculateNextTurn does on a normal round end (see
      // gameSlice.nextTurn / advanceTurnOnTimeout) — without it, the round this
      // removal forces past never gets a chart data point, and the end-screen
      // score-per-round chart silently comes up one round short.
      if (state.chartValues.length === state.players.length && state.chartNames.length === state.players.length) {
        state.chartValues.forEach((vals, i) => vals.push(state.players[i].score));
        state.chartLabels.push(state.round);
      }
      // Same win check calculateNextTurn runs at the same round boundary —
      // without it, a removal that forces the round past a sole leader who
      // already reached winningScore hands out a whole extra round instead of
      // ending the game there (during which e.g. a Plus/Minus could even flip
      // the winner).
      const leaders = getLeaders(state.players);
      isGameOver = leaders.length === 1 && leaders[0].score >= state.winningScore;
      if (!isGameOver) state.round += 1;
    }
    if (isGameOver) {
      state.finished = true;
      state.currentPlayerIndex = null;
      state.currentCard = null;
      state.turnStartTime = null;
      if (room.gameActualStartTime) {
        state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
        room.gameActualStartTime = null;
      }
    } else {
      state.turnStartTime = Date.now();
      drawNextCardForRoom(state);
    }
  }

  // Keep pushState's turn-change tracking in step with the adjusted index/card.
  // Without this, the next pushState compares against the pre-removal values,
  // misreads the shifted index (or freshly drawn card) as a brand-new turn, and
  // resets turnStartTime again — granting the active player extra time.
  if (!room.turnTimerState) {
    room.turnTimerState = { lastCard: null, lastPlayerIndex: null };
  }
  room.turnTimerState.lastCard = state.currentCard;
  room.turnTimerState.lastPlayerIndex = state.currentPlayerIndex;
};

export const calculateGameTime = (room: Room): number => {
  if (!room.gameActualStartTime || room.state.status !== 'playing') {
    return room.state.gameTimeInSeconds;
  }
  return Math.floor((Date.now() - room.gameActualStartTime) / 1000);
};

export const calculateRemainingTurnTime = (room: Room): number | null => {
  if (!room.state.turnStartTime || room.state.turnDuration === 0) return null;

  const targetDuration = getEffectiveTurnDuration(room.state.currentCard, room.state.turnDuration);
  const elapsedSeconds = Math.floor((Date.now() - room.state.turnStartTime) / 1000);
  return Math.max(0, targetDuration - elapsedSeconds);
};

// deviceId is a reconnect credential (see joinRoom: possession of a player's
// deviceId is enough to take over their seat), so it must never be broadcast
// to other room members — only the owning client's own outgoing joinRoom call
// carries it. previousLeaders is a snapshot of full player objects and needs
// the same scrubbing.
export const sanitizePlayerForBroadcast = (p: ServerPlayer): Omit<ServerPlayer, 'deviceId'> => {
  const rest: Partial<ServerPlayer> = { ...p };
  delete rest.deviceId;
  return rest as Omit<ServerPlayer, 'deviceId'>;
};

export const emitRoomState = (io: Server, roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  const gameState = {
    ...room.state,
    players: room.state.players.map(sanitizePlayerForBroadcast),
    previousLeaders: room.state.previousLeaders
      ? room.state.previousLeaders.map(sanitizePlayerForBroadcast)
      : room.state.previousLeaders,
    turnTimeRemaining: calculateRemainingTurnTime(room),
    gameTimeInSeconds: calculateGameTime(room),
  };
  io.to(roomId).emit('gameState', gameState);
  io.to(roomId).emit('hostId', room.host);
};
