import type { Server } from 'socket.io';
import { buildDeck } from '../src/utils/coreGameEngine';
import { getEffectiveTurnDuration } from '../src/utils/turnDuration';
import {
  DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE, DEFAULT_TURN_DURATION, DEFAULT_RECONNECT_TIMEOUT,
} from '../src/utils/configValidation';
import type { Room, RoomState, ServerPlayer } from './roomTypes';

export const rooms: Record<string, Room> = {};

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
  },
});

export const drawNextCardForRoom = (state: RoomState): void => {
  if (state.cards && state.cards.length > 0) {
    state.currentCard = state.cards.shift() ?? null;
  } else {
    const deck = buildDeck(state.initialCards);
    state.currentCard = deck.shift() ?? null;
    state.cards = deck;
  }
};

export const handleActivePlayerRemoved = (state: RoomState, removedIdx: number): void => {
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
    // The removed player was mid-turn — drop their live dice snapshot so
    // spectators don't keep seeing it attributed to the player now in this slot.
    state.liveTurnState = null;
    if (removedPlayerWasLastInOrder) state.round += 1;
    state.turnStartTime = Date.now();
    drawNextCardForRoom(state);
  }
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
