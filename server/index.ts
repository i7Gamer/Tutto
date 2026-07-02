import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { sanitizeStats } from './sanitize';
import type { CardType, InitialCards, Player, DiceSnapshot, CoreGameState } from '../src/types';
import { calculateNextTurn, buildDeck } from '../src/utils/coreGameEngine';
import { getEffectiveTurnDuration } from '../src/utils/turnDuration';
import { isValidWinningScore, isValidTurnDuration, isValidReconnectTimeout, isValidCardEntry, MAX_CARD_COUNT, VALID_CARD_TYPES } from '../src/utils/configValidation';
import playerColorsData from '../playerColors.json';
const { PLAYER_COLORS } = playerColorsData;

// ─── Types ────────────────────────────────────────────────────────────────────

// CardType / InitialCards / Player are shared with the client (src/types.ts) to
// keep the card set and player shape from drifting. The server requires the
// connection fields the client treats as optional, so narrow them here.
type ServerPlayer = Omit<Player, 'deviceId' | 'socketId' | 'color' | 'disconnected'> & {
  deviceId: string;
  socketId: string;
  color: string;
  disconnected: boolean;
};

interface RoomState {
  players: ServerPlayer[];
  status: 'lobby' | 'playing';
  initialCards: InitialCards;
  winningScore: number;
  randomOrder: boolean;
  turnDuration: number;
  reconnectTimeout: number;
  currentCard: CardType | null;
  cards: CardType[];
  round: number;
  currentPlayerIndex: number | null;
  finished: boolean;
  chartValues: number[][];
  chartNames: string[];
  chartLabels: number[];
  gameTimeInSeconds: number;
  turnStartTime: number | null;
  previousCard: CardType | null;
  previousScore: number | null;
  previousLeaders: ServerPlayer[] | null;
  previousWasBust?: boolean;
  previousHighestTurnScore?: number;
  liveTurnState?: DiceSnapshot | null;
}

interface TurnTimerState {
  lastCard: CardType | null;
  lastPlayerIndex: number | null;
}

// Tracks which devices/global stats have already been recorded for the room's
// CURRENT game — reset whenever a new game starts (see pushState's startingGame
// branch). Without this, a player who reconnects or reloads after their game
// already finished (but before leaving the room) re-triggers their client's
// "finished just became true" stats submission on every reconnect, repeatedly
// inflating both their device stats and, if they're host, the global stats.
interface StatsRecordedForGame {
  devices: Set<string>;
  global: boolean;
}

interface Room {
  host: string;
  state: RoomState;
  gameActualStartTime: number | null;
  turnTimerState: TurnTimerState | null;
  disconnectTimers: Record<string, ReturnType<typeof setTimeout>>;
  turnExpireTimer: ReturnType<typeof setTimeout> | null;
  statsRecordedForGame: StatsRecordedForGame;
}

// ─── App setup ────────────────────────────────────────────────────────────────

// Defaults to '*' (any origin) to preserve local-dev/LAN-play behaviour when
// unset. Set CORS_ORIGIN to the deployed origin (e.g. https://tutto.rzipas.win)
// in production to lock this down.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN },
  pingInterval: 4000,
  pingTimeout: 6000,
});

// ─── Constants ────────────────────────────────────────────────────────────────

// A fully-loaded deck has at most MAX_CARD_COUNT of each of the 11 card types.
const MAX_DECK_SIZE = MAX_CARD_COUNT * 11;
// Generous safety cap for per-round arrays (chartLabels/chartValues entries) — far
// beyond any real game, just enough to stop a malicious pushState from growing
// these arrays without bound.
const MAX_ROUNDS = 100000;
const MAX_SCORE_MAGNITUDE = 1_000_000;
const MAX_GAME_SECONDS = 10_000_000;

const validateInitialCards = (cards: unknown): cards is InitialCards => {
  if (typeof cards !== 'object' || cards === null) return false;
  const entries = Object.entries(cards as Record<string, unknown>);
  if (entries.length === 0) return false;
  const shapeValid = entries.every(([key, val]) => isValidCardEntry(key, val));
  if (!shapeValid) return false;
  // An all-zero deck leaves currentCard permanently null and the game unplayable.
  return entries.some(([, val]) => (val as number) > 0);
};

// Applies only the config fields that pass validation, silently ignoring the
// rest. Shared by every path that lets a client write room configuration
// (updateConfig and joinRoom's initialConfig) so the accepted ranges can never
// drift apart between them.
const applyValidatedConfig = (state: RoomState, config: Record<string, unknown>): void => {
  const { winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout } = config;
  if (isValidWinningScore(winningScore)) state.winningScore = winningScore;
  if (validateInitialCards(initialCards)) state.initialCards = initialCards;
  if (typeof randomOrder === 'boolean') state.randomOrder = randomOrder;
  if (isValidTurnDuration(turnDuration)) state.turnDuration = turnDuration;
  if (isValidReconnectTimeout(reconnectTimeout)) state.reconnectTimeout = reconnectTimeout;
};

// Minimal shape check for a previousLeaders snapshot entry — just enough for
// calculateUndo (client-side) to read name/score back out safely.
const isPlausiblePlayerSnapshot = (v: unknown): v is { name: string; score: number } => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.name === 'string' && typeof p.score === 'number' && Number.isFinite(p.score);
};

const isValidDiceSnapshot = (v: unknown): v is DiceSnapshot => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.turnScore === 'number' && Number.isFinite(s.turnScore)
    && typeof s.tuttosThisTurn === 'number' && Number.isFinite(s.tuttosThisTurn)
    && Array.isArray(s.keptDice)
    && Array.isArray(s.currentRoll)
    && Array.isArray(s.kniffelProgress);
};

const HOST_ONLY_FIELDS = new Set<string>([
  'status', 'winningScore', 'initialCards', 'randomOrder',
  'turnDuration', 'reconnectTimeout',
]);

const ACTIVE_PLAYER_FIELDS = new Set<string>([
  'currentCard', 'cards', 'currentPlayerIndex', 'round',
  'finished', 'previousCard', 'previousScore', 'previousLeaders',
  'previousWasBust', 'previousHighestTurnScore',
  'chartValues', 'chartNames', 'chartLabels', 'gameTimeInSeconds',
  'players', 'liveTurnState',
]);

const ALL_FIELDS = new Set<string>([...HOST_ONLY_FIELDS, ...ACTIVE_PLAYER_FIELDS]);

// Upper bounds for numeric config fields arriving via pushState. Unlike
// applyValidatedConfig this is a sanity guard, not a UX rule (pushState mirrors
// state the client already ran through updateConfig, and tests legitimately
// push short 1-2s turns): it only rejects values that would corrupt server-side
// logic — a negative/non-finite turnDuration makes startServerTurnTimer re-arm
// with remaining<=0 and advance turns in a synchronous loop until the stack
// overflows, and an unvalidated initialCards object can send buildDeck into an
// unbounded loop on the next deck rebuild.
const PUSHED_NUMERIC_FIELD_MAX: Record<string, number> = {
  winningScore: 99999,
  turnDuration: 600,
  reconnectTimeout: 3600,
};

const PLAYER_MUTABLE: (keyof ServerPlayer)[] = [
  'score', 'times1000PointsDeducted', 'timesKniffelCompleted',
  'timesPlusMinusCompleted', 'timesKniffelFailed', 'timesKleeblattFailed',
  'timesKleeblattCompleted', 'timesPlusMinusFailed', 'timesFeuerwerkReceived',
  'timesSkipped', 'timesx2Received', 'totalTurns', 'busts',
  'feuerwerkBusts', 'x2Busts', 'feuerwerkPointsScored', 'x2PointsScored',
  'highestTurnScore', 'position', 'color', 'disconnected',
];

const rooms: Record<string, Room> = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const drawNextCardForRoom = (state: RoomState): void => {
  if (state.cards && state.cards.length > 0) {
    state.currentCard = state.cards.shift() ?? null;
  } else {
    const deck = buildDeck(state.initialCards);
    state.currentCard = deck.shift() ?? null;
    state.cards = deck;
  }
};

const handleActivePlayerRemoved = (state: RoomState, removedIdx: number): void => {
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

const calculateGameTime = (room: Room): number => {
  if (!room.gameActualStartTime || room.state.status !== 'playing') {
    return room.state.gameTimeInSeconds;
  }
  return Math.floor((Date.now() - room.gameActualStartTime) / 1000);
};

const calculateRemainingTurnTime = (room: Room): number | null => {
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
const sanitizePlayerForBroadcast = (p: ServerPlayer): Omit<ServerPlayer, 'deviceId'> => {
  const rest: Partial<ServerPlayer> = { ...p };
  delete rest.deviceId;
  return rest as Omit<ServerPlayer, 'deviceId'>;
};

const emitRoomState = (roomId: string): void => {
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

const clearServerTurnTimer = (roomId: string): void => {
  const room = rooms[roomId];
  if (!room || !room.turnExpireTimer) return;
  clearTimeout(room.turnExpireTimer);
  room.turnExpireTimer = null;
};

// The server is the sole authority on turn expiry: no client (host or otherwise)
// advances the turn on timeout anymore. This runs even if every player has
// disconnected, so a dead host tab or a backgrounded/throttled client tab can
// never stall the game for everyone else.
const advanceTurnOnTimeout = (roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  room.turnExpireTimer = null;

  if (room.state.finished || room.state.status !== 'playing' || room.state.currentPlayerIndex === null) {
    return;
  }

  try {
    const currentPlayerIndex = room.state.currentPlayerIndex;

    // calculateNextTurn only reads players/currentPlayerIndex/currentCard/round/
    // winningScore/cards/initialCards — the remaining CoreGameState fields are
    // unused by it but required by the type, so they're filled with inert values.
    const stateForCalc = {
      players: room.state.players,
      currentPlayerIndex,
      currentCard: room.state.currentCard,
      round: room.state.round,
      winningScore: room.state.winningScore,
      cards: room.state.cards,
      initialCards: room.state.initialCards,
      previousCard: room.state.previousCard,
      previousScore: room.state.previousScore,
      previousLeaders: room.state.previousLeaders,
      previousWasBust: room.state.previousWasBust ?? false,
      previousHighestTurnScore: room.state.previousHighestTurnScore ?? 0,
      finished: room.state.finished,
      gameStartTime: null,
      gameTimeInSeconds: room.state.gameTimeInSeconds,
    };

    // Timeout = the player neither scored nor answered in time, same as a manual
    // "Stop & Score 0" — matches what the client used to send on host-side expiry.
    const result = calculateNextTurn(
      stateForCalc as unknown as CoreGameState & { currentPlayerIndex: number },
      0,
      false,
    );

    room.state.players = result.players as ServerPlayer[];
    room.state.previousCard = result.previousCard;
    room.state.previousScore = result.previousScore;
    room.state.previousLeaders = result.previousLeaders as ServerPlayer[] | null;
    room.state.previousWasBust = result.previousWasBust;
    room.state.previousHighestTurnScore = result.previousHighestTurnScore;
    room.state.liveTurnState = null;

    if (result.isRoundEnd) {
      room.state.chartValues.forEach((vals, i) => vals.push(result.players[i]?.score ?? 0));
      room.state.chartLabels.push(room.state.round);
    }

    if (!room.turnTimerState) {
      room.turnTimerState = { lastCard: null, lastPlayerIndex: null };
    }

    if (result.isGameOver) {
      room.state.finished = true;
      room.state.currentPlayerIndex = null;
      room.state.currentCard = null;
      room.state.turnStartTime = null;
      if (room.gameActualStartTime) {
        room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
        room.gameActualStartTime = null;
      }
      room.turnTimerState.lastCard = null;
      room.turnTimerState.lastPlayerIndex = null;
    } else {
      room.state.currentPlayerIndex = result.nextIndex;
      room.state.round = result.nextRound;
      room.state.cards = result.newDeck;
      room.state.currentCard = result.drawnCard;
      room.state.turnStartTime = Date.now();
      // Mark this as the "already seen" turn so the next pushState's cardChanged/
      // playerChanged check doesn't treat it as a fresh turn and reschedule again.
      room.turnTimerState.lastCard = result.drawnCard;
      room.turnTimerState.lastPlayerIndex = result.nextIndex;
      startServerTurnTimer(roomId);
    }

    emitRoomState(roomId);
  } catch (err) {
    // Backstop: pushState's own validation should make a malformed room state
    // unreachable, but this callback runs on a bare setTimeout with no caller to
    // catch a throw — an uncaught exception here would crash the whole process
    // (every room, every player), not just this one room's turn.
    console.error(`[turnTimer] Failed to advance turn for room ${roomId}:`, err);
  }
};

// Schedules (or reschedules) the server-side expiry for the room's current turn,
// based on room.state.turnStartTime and the authoritative remaining-time formula
// (calculateRemainingTurnTime) — the same value clients are shown. Safe to call
// repeatedly: it always clears any existing timer first, so config changes or
// player-removal events mid-turn can simply call this again to resync.
const startServerTurnTimer = (roomId: string): void => {
  clearServerTurnTimer(roomId);
  const room = rooms[roomId];
  if (!room) return;
  if (room.state.status !== 'playing' || room.state.finished || room.state.currentPlayerIndex === null) return;
  if (!room.state.turnDuration || !room.state.turnStartTime) return;

  const remainingSeconds = calculateRemainingTurnTime(room);
  if (remainingSeconds === null) return;

  if (remainingSeconds <= 0) {
    // Duration was shortened below the already-elapsed time (e.g. host lowered
    // turnDuration mid-turn) — the turn is already over, advance immediately.
    advanceTurnOnTimeout(roomId);
    return;
  }

  room.turnExpireTimer = setTimeout(() => advanceTurnOnTimeout(roomId), remainingSeconds * 1000);
};

const abortGameIfLowPlayers = (room: Room, roomId: string): boolean => {
  if (room.state.status === 'playing' && room.state.players.length < 2) {
    clearServerTurnTimer(roomId);
    io.to(roomId).emit('gameAborted');
    room.state.status = 'lobby';
    room.state.currentCard = null;
    room.state.currentPlayerIndex = null;
    room.state.finished = false;
    room.state.turnStartTime = null;
    // Without this, the aborted game's elapsed time (plus however long the room
    // then sits idle in the lobby) bleeds into the next game's clock and stats,
    // since gameActualStartTime is only otherwise reset when a client pushes a
    // lobby/finished state — which never happens on a server-initiated abort.
    room.gameActualStartTime = null;
    if (room.turnTimerState) {
      room.turnTimerState.lastCard = null;
      room.turnTimerState.lastPlayerIndex = null;
    }
    return true;
  }
  return false;
};

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
  let currentRoom: string | null = null;
  let username: string | null = null;

  socket.on('joinRoom', (
    { roomId, name, deviceId, color, initialConfig }: { roomId: string; name: string; deviceId: string; color?: string; initialConfig?: Record<string, unknown> } =
      {} as { roomId: string; name: string; deviceId: string; color?: string; initialConfig?: Record<string, unknown> },
    callback: (result: { success: boolean; isHost?: boolean; socketId?: string; error?: string }) => void
  ) => {
    // Reject malformed payloads before any field is used. Without these guards a
    // client that omits the ack callback or sends a non-string name crashes the
    // handler (e.g. name.toLowerCase() throws), which can take down the server.
    if (typeof callback !== 'function') return;
    if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 100) {
      return callback({ success: false, error: 'Invalid room' });
    }
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 200) {
      return callback({ success: false, error: 'Invalid device' });
    }
    if (typeof name !== 'string') {
      return callback({ success: false, error: 'Invalid name' });
    }
    name = name.trim();
    if (name.length === 0 || name.length > 30) {
      return callback({ success: false, error: 'Invalid name' });
    }

    // A socket may only be an active member of one room at a time. Without this,
    // joining a second, different room without leaving the first leaves a ghost
    // player entry behind forever (currentRoom is just overwritten below) — an
    // unbounded way to accumulate abandoned rooms.
    if (currentRoom && currentRoom !== roomId) {
      socket.leave(currentRoom);
      handlePlayerLeave(true);
      currentRoom = null;
      username = null;
    }

    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: socket.id,
        gameActualStartTime: null,
        turnTimerState: null,
        disconnectTimers: {},
        turnExpireTimer: null,
        statsRecordedForGame: { devices: new Set(), global: false },
        state: {
          players: [],
          status: 'lobby',
          initialCards: {
            Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5,
            Plus_Minus: 5, x2: 5, '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
          },
          winningScore: 6000,
          randomOrder: true,
          turnDuration: 120,
          reconnectTimeout: 60,
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
      };

      if (initialConfig && typeof initialConfig === 'object') {
        applyValidatedConfig(rooms[roomId].state, initialConfig);
      }
    }

    const room = rooms[roomId];

    const existingPlayer = room.state.players.find(p => p.deviceId === deviceId);
    if (existingPlayer) {
      const nameTakenByOther = room.state.players.some(
        p => p.deviceId !== deviceId && !p.disconnected && p.name.toLowerCase() === name.toLowerCase()
      );
      if (nameTakenByOther) {
        return callback({ success: false, error: 'Username already exists in this room' });
      }
      if (room.host === existingPlayer.socketId) room.host = socket.id;
      existingPlayer.socketId = socket.id;
      existingPlayer.name = name;
      existingPlayer.disconnected = false;

      if (room.disconnectTimers[deviceId]) {
        clearTimeout(room.disconnectTimers[deviceId]);
        delete room.disconnectTimers[deviceId];
      }

      socket.join(roomId);
      currentRoom = roomId;
      username = name;
      callback({ success: true, isHost: room.host === socket.id, socketId: socket.id });
      emitRoomState(roomId);
      return;
    }

    if (room.state.status !== 'lobby') {
      return callback({ success: false, error: 'Game is already running. You cannot join mid-game.' });
    }

    const nameConflict = room.state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (nameConflict) {
      // The conflicting player is still holding the name so they can reconnect —
      // let the host know in case they'd rather kick the ghost and free it up.
      if (nameConflict.disconnected) {
        io.to(room.host).emit('nameConflictWithDisconnected', nameConflict.name);
      }
      return callback({ success: false, error: 'Username already exists in this room' });
    }

    socket.join(roomId);
    currentRoom = roomId;
    username = name;

    const colorRe = /^#[0-9a-fA-F]{6}$/i;
    let assignedColor: string | null = color && colorRe.test(color) ? color : null;
    const usedColors = room.state.players.map(p => p.color);
    if (!assignedColor) assignedColor = PLAYER_COLORS.find((c: string) => !usedColors.includes(c)) ?? null;
    if (!assignedColor) assignedColor = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)] as string;

    const newPlayer: ServerPlayer = {
      name,
      deviceId,
      socketId: socket.id,
      score: 0,
      times1000PointsDeducted: 0,
      timesKniffelCompleted: 0,
      timesPlusMinusCompleted: 0,
      timesKniffelFailed: 0,
      timesKleeblattFailed: 0,
      timesKleeblattCompleted: 0,
      timesPlusMinusFailed: 0,
      timesFeuerwerkReceived: 0,
      timesSkipped: 0,
      timesx2Received: 0,
      totalTurns: 0,
      busts: 0,
      feuerwerkBusts: 0,
      x2Busts: 0,
      feuerwerkPointsScored: 0,
      x2PointsScored: 0,
      position: 0,
      color: assignedColor,
      disconnected: false,
    };
    room.state.players.push(newPlayer);

    callback({ success: true, isHost: room.host === socket.id, socketId: socket.id });
    emitRoomState(roomId);
  });

  socket.on('updateConfig', ({
    roomId, winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout,
  }: {
    roomId: string;
    winningScore?: number;
    initialCards?: unknown;
    randomOrder?: boolean;
    turnDuration?: number;
    reconnectTimeout?: number;
  }) => {
    if (!rooms[roomId] || rooms[roomId].host !== socket.id) return;
    applyValidatedConfig(rooms[roomId].state, { winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout });
    // Resync the pending expiry to the (possibly just-changed) turnDuration. A
    // no-op if no turn is in progress; startServerTurnTimer's own guards handle that.
    startServerTurnTimer(roomId);
    emitRoomState(roomId);
  });

  socket.on('reorderPlayers', ({ roomId, newPlayers }: { roomId: string; newPlayers: { name: string }[] } =
    {} as { roomId: string; newPlayers: { name: string }[] }) => {
    if (!rooms[roomId] || rooms[roomId].host !== socket.id) return;
    if (rooms[roomId].state.status !== 'lobby') return;
    // Guard against non-array payloads, which would throw on the .map/.length below.
    if (!Array.isArray(newPlayers)) return;

    const currentNames = new Set(rooms[roomId].state.players.map(p => p.name));
    const newNames = new Set(newPlayers.map(p => p.name));
    const isPermutation =
      newPlayers.length === rooms[roomId].state.players.length &&
      currentNames.size === newNames.size &&
      newPlayers.every(p => currentNames.has(p.name));

    if (isPermutation) {
      rooms[roomId].state.players = newPlayers
        .map(np => rooms[roomId].state.players.find(p => p.name === np.name))
        .filter((p): p is ServerPlayer => p !== undefined);
      rooms[roomId].state.randomOrder = false;
      emitRoomState(roomId);
    }
  });

  socket.on('updatePlayerColor', ({ roomId, color }: { roomId: string; color: string }) => {
    if (!rooms[roomId]) return;
    const colorRe = /^#[0-9a-fA-F]{6}$/i;
    if (!color || !colorRe.test(color)) return;
    const player = rooms[roomId].state.players.find(p => p.socketId === socket.id);
    if (player) {
      player.color = color;
      emitRoomState(roomId);
    }
  });

  socket.on('kickPlayer', (targetSocketId: string) => {
    if (!currentRoom || !rooms[currentRoom] || rooms[currentRoom].host !== socket.id) return;
    const room = rooms[currentRoom];

    io.to(targetSocketId).emit('kicked');

    const removedIdx = room.state.players.findIndex(p => p.socketId === targetSocketId);
    if (removedIdx !== -1) {
      room.state.players.splice(removedIdx, 1);
      handleActivePlayerRemoved(room.state, removedIdx);
    }

    if (room.state.players.length === 0) {
      clearServerTurnTimer(currentRoom);
      delete rooms[currentRoom];
    } else {
      const aborted = abortGameIfLowPlayers(room, currentRoom);
      // If the kicked player was mid-turn, handleActivePlayerRemoved already
      // reset turnStartTime for the player now in their slot — resync the timer.
      if (!aborted) startServerTurnTimer(currentRoom);
      emitRoomState(currentRoom);
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) targetSocket.leave(currentRoom);
  });

  // Matched by name, not deviceId: name is already unique within a room (enforced
  // at join) and, unlike deviceId, was never meant to be secret — reorderPlayers
  // already keys off it the same way. Keeping deviceId out of this match means it
  // never has to round-trip through a broadcast (see sanitizePlayerForBroadcast).
  const validatePushedPlayers = (existing: ServerPlayer[], pushed: unknown[]): boolean => {
    if (!Array.isArray(pushed) || pushed.length !== existing.length) return false;
    const existingNames = new Set(existing.map(p => p.name));
    return pushed.every(p => typeof p === 'object' && p !== null && existingNames.has((p as { name?: string }).name ?? ''));
  };

  socket.on('pushState', ({ roomId, newState }: { roomId: string; newState: Record<string, unknown> }) => {
    try {
      const room = rooms[roomId];
      if (!room || !newState || typeof newState !== 'object') return;

      const isHost = room.host === socket.id;
      const activePlayer = room.state.currentPlayerIndex !== null
        ? room.state.players[room.state.currentPlayerIndex]
        : null;
      const isActivePlayer = activePlayer?.socketId === socket.id;

      if (!isHost && !isActivePlayer) return;

      const allowedFields = isHost ? ALL_FIELDS : ACTIVE_PLAYER_FIELDS;

      // The host may legitimately reorder players (e.g. the random shuffle) only at
      // the moment the game starts. Outside that transition the server keeps its own
      // authoritative order so a stray push can never scramble the roster mid-game.
      const startingGame = isHost && room.state.status === 'lobby' && newState.status === 'playing';
      if (startingGame) {
        room.statsRecordedForGame = { devices: new Set(), global: false };
      }

      const mergeMutable = (existing: ServerPlayer, p: Record<string, unknown> | undefined): ServerPlayer => {
        if (!p) return existing;
        const updated = { ...existing };
        for (const f of PLAYER_MUTABLE) {
          if (!(f in p)) continue;
          const v = p[f];
          if (f === 'color') {
            if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) updated.color = v;
          } else if (f === 'disconnected') {
            if (typeof v === 'boolean') updated.disconnected = v;
          } else if (typeof v === 'number' && Number.isFinite(v)) {
            (updated as Record<string, unknown>)[f] = v;
          }
        }
        return updated;
      };

      for (const key of allowedFields) {
        if (!(key in newState)) continue;
        if (key === 'players') {
          const pushed = newState.players as Record<string, unknown>[];
          if (!validatePushedPlayers(room.state.players, pushed)) continue;

          const pushedNames = pushed.map(p => p.name as string);
          const isStrictPermutation = new Set(pushedNames).size === room.state.players.length;

          if (startingGame && isStrictPermutation) {
            // Adopt the host's chosen ordering, but keep the server-side player
            // identities and non-mutable fields. Keeps chartNames/chartValues
            // (pushed in the same order) aligned with the authoritative roster.
            const byName = new Map(room.state.players.map(p => [p.name, p]));
            room.state.players = pushedNames.map(name =>
              mergeMutable(byName.get(name)!, pushed.find(q => q.name === name)),
            );
          } else {
            room.state.players = room.state.players.map(existing =>
              mergeMutable(existing, pushed.find(q => q.name === existing.name)),
            );
          }
        } else if (key in PUSHED_NUMERIC_FIELD_MAX) {
          const v = newState[key];
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= PUSHED_NUMERIC_FIELD_MAX[key]) {
            (room.state as unknown as Record<string, unknown>)[key] = v;
          }
        } else if (key === 'initialCards') {
          if (validateInitialCards(newState.initialCards)) room.state.initialCards = newState.initialCards;
        } else if (key === 'status') {
          if (newState.status === 'lobby' || newState.status === 'playing') room.state.status = newState.status;
        } else if (key === 'randomOrder') {
          if (typeof newState.randomOrder === 'boolean') room.state.randomOrder = newState.randomOrder;
        } else if (key === 'currentCard' || key === 'previousCard') {
          const v = newState[key];
          if (v === null || VALID_CARD_TYPES.includes(v as CardType)) {
            (room.state as unknown as Record<string, unknown>)[key] = v;
          }
        } else if (key === 'cards') {
          const v = newState.cards;
          if (Array.isArray(v) && v.length <= MAX_DECK_SIZE && v.every(c => VALID_CARD_TYPES.includes(c as CardType))) {
            room.state.cards = v as CardType[];
          }
        } else if (key === 'currentPlayerIndex') {
          const v = newState.currentPlayerIndex;
          if (v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) < room.state.players.length)) {
            room.state.currentPlayerIndex = v as number | null;
          }
        } else if (key === 'round') {
          const v = newState.round;
          if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_ROUNDS) {
            room.state.round = v;
          }
        } else if (key === 'finished') {
          if (typeof newState.finished === 'boolean') room.state.finished = newState.finished;
        } else if (key === 'previousScore') {
          const v = newState.previousScore;
          if (v === null || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_SCORE_MAGNITUDE)) {
            room.state.previousScore = v as number | null;
          }
        } else if (key === 'previousLeaders') {
          const v = newState.previousLeaders;
          if (v === null) {
            room.state.previousLeaders = null;
          } else if (Array.isArray(v) && v.length <= room.state.players.length && v.every(isPlausiblePlayerSnapshot)) {
            room.state.previousLeaders = v as ServerPlayer[];
          }
        } else if (key === 'previousWasBust') {
          if (typeof newState.previousWasBust === 'boolean') room.state.previousWasBust = newState.previousWasBust;
        } else if (key === 'previousHighestTurnScore') {
          const v = newState.previousHighestTurnScore;
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SCORE_MAGNITUDE) {
            room.state.previousHighestTurnScore = v;
          }
        } else if (key === 'chartValues') {
          const v = newState.chartValues;
          if (
            Array.isArray(v) && v.length === room.state.players.length &&
            v.every(arr => Array.isArray(arr) && arr.length <= MAX_ROUNDS && arr.every(n => typeof n === 'number' && Number.isFinite(n)))
          ) {
            room.state.chartValues = v as number[][];
          }
        } else if (key === 'chartNames') {
          const v = newState.chartNames;
          if (Array.isArray(v) && v.length === room.state.players.length && v.every(n => typeof n === 'string')) {
            room.state.chartNames = v as string[];
          }
        } else if (key === 'chartLabels') {
          const v = newState.chartLabels;
          if (Array.isArray(v) && v.length <= MAX_ROUNDS && v.every(n => typeof n === 'number' && Number.isFinite(n))) {
            room.state.chartLabels = v as number[];
          }
        } else if (key === 'gameTimeInSeconds') {
          const v = newState.gameTimeInSeconds;
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_GAME_SECONDS) {
            room.state.gameTimeInSeconds = v;
          }
        } else if (key === 'liveTurnState') {
          const v = newState.liveTurnState;
          if (v === null || isValidDiceSnapshot(v)) {
            room.state.liveTurnState = v as DiceSnapshot | null;
          }
        }
      }

      if (room.state.status === 'playing' && !room.gameActualStartTime) {
        room.gameActualStartTime = Date.now();
      }

      if (!room.turnTimerState) {
        room.turnTimerState = { lastCard: null, lastPlayerIndex: null };
      }

      const cardChanged = room.state.currentCard !== room.turnTimerState.lastCard;
      const playerChanged = room.state.currentPlayerIndex !== room.turnTimerState.lastPlayerIndex;

      if (room.state.status === 'playing' && room.state.currentPlayerIndex !== null && (cardChanged || playerChanged)) {
        room.state.turnStartTime = Date.now();
        room.turnTimerState.lastCard = room.state.currentCard;
        room.turnTimerState.lastPlayerIndex = room.state.currentPlayerIndex;
        startServerTurnTimer(roomId);
      }

      if (room.state.finished || room.state.status === 'lobby') {
        clearServerTurnTimer(roomId);
        room.state.turnStartTime = null;
        if (room.gameActualStartTime) {
          room.state.gameTimeInSeconds = Math.floor((Date.now() - room.gameActualStartTime) / 1000);
        }
        room.gameActualStartTime = null;
        if (room.turnTimerState) {
          room.turnTimerState.lastCard = null;
          room.turnTimerState.lastPlayerIndex = null;
        }
      }

      emitRoomState(roomId);
    } catch (err) {
      // Backstop: validation above should make this unreachable, but a crash here
      // would otherwise take down the whole process (every room, every player) —
      // see advanceTurnOnTimeout for the same reasoning.
      console.error(`[pushState] Failed to apply state for room ${roomId}:`, err);
    }
  });

  socket.on('submitGlobalStats', async ({ roomId, payload }: { roomId: string; payload: unknown } =
    {} as { roomId: string; payload: unknown }) => {
    // Only the room host may submit global stats, authenticated by socket identity.
    // No token needed — the WebSocket session is the credential.
    const room = roomId ? rooms[roomId] : null;
    if (!room || room.host !== socket.id) return;
    // A reconnect/reload after the game already finished (but before anyone
    // leaves the room) makes the client think "finished just became true" again,
    // re-submitting for the same game. Recorded per game, reset when a new one
    // starts (see pushState's startingGame branch).
    if (room.statsRecordedForGame.global) return;
    room.statsRecordedForGame.global = true;
    try {
      await updateGlobalStats(sanitizeStats(payload));
    } catch (err) {
      console.error('submitGlobalStats error:', err);
    }
  });

  socket.on('endGameStats', async ({ deviceId, stats }: { deviceId: string; stats: unknown } =
    {} as { deviceId: string; stats: unknown }) => {
    if (!deviceId) return;
    // A socket may only submit stats for its OWN device, and only while it is a
    // member of its current room. This mirrors the token gate on the HTTP path
    // (POST /api/stats/:deviceId) so the socket route can't be used to write
    // arbitrary device statistics.
    const room = currentRoom ? rooms[currentRoom] : null;
    const player = room?.state.players.find(p => p.socketId === socket.id);
    if (!player || player.deviceId !== deviceId || !room) return;
    // See submitGlobalStats above — same reconnect-after-finish dedup, per device.
    if (room.statsRecordedForGame.devices.has(deviceId)) return;
    room.statsRecordedForGame.devices.add(deviceId);
    try {
      await updateDeviceStats(deviceId, sanitizeStats(stats));
    } catch (err) {
      console.error(err);
    }
  });

  const handlePlayerLeave = (isExplicitLeave = false): void => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const playerIndex = room.state.players.findIndex(p => p.socketId === socket.id);

    if (playerIndex === -1) return;
    const player = room.state.players[playerIndex];

    if (isExplicitLeave) {
      room.state.players.splice(playerIndex, 1);
      handleActivePlayerRemoved(room.state, playerIndex);

      if (room.disconnectTimers[player.deviceId]) {
        clearTimeout(room.disconnectTimers[player.deviceId]);
        delete room.disconnectTimers[player.deviceId];
      }

      if (room.state.players.length === 0) {
        clearServerTurnTimer(currentRoom);
        delete rooms[currentRoom];
        return;
      } else if (room.host === socket.id) {
        const nextHost = room.state.players.find(p => !p.disconnected);
        if (!nextHost) {
          for (const p of room.state.players) {
            io.to(p.socketId).emit('kicked');
          }
          clearServerTurnTimer(currentRoom);
          delete rooms[currentRoom];
          return;
        }
        room.host = nextHost.socketId;
      } else if (
        room.state.players.every(p => p.disconnected) &&
        Object.keys(room.disconnectTimers).length === 0
      ) {
        // All remaining players are disconnected with no reconnect timers
        // (e.g. reconnectTimeout=0). The room would never be cleaned up otherwise.
        clearServerTurnTimer(currentRoom);
        delete rooms[currentRoom];
        return;
      }
      {
        const aborted = abortGameIfLowPlayers(room, currentRoom);
        if (!aborted) startServerTurnTimer(currentRoom);
      }
      emitRoomState(currentRoom);
    } else {
      player.disconnected = true;
      emitRoomState(currentRoom);
      io.to(currentRoom).emit('playerDisconnected', username);

      if (!room.disconnectTimers) room.disconnectTimers = {};
      const timeoutSecs = room.state.reconnectTimeout ?? 60;
      if (timeoutSecs === 0) {
        if (room.state.players.every(p => p.disconnected)) {
          clearServerTurnTimer(currentRoom);
          delete rooms[currentRoom];
        }
        return;
      }

      const roomIdSnapshot = currentRoom;
      const hostSocketId = socket.id;

      room.disconnectTimers[player.deviceId] = setTimeout(() => {
        const r = rooms[roomIdSnapshot];
        if (!r) return;
        const removedIdx = r.state.players.findIndex(p => p.deviceId === player.deviceId);
        if (removedIdx === -1) return;
        r.state.players.splice(removedIdx, 1);
        handleActivePlayerRemoved(r.state, removedIdx);

        if (r.state.players.length === 0) {
          clearServerTurnTimer(roomIdSnapshot);
          delete rooms[roomIdSnapshot];
        } else {
          if (r.host === hostSocketId) {
            r.host = r.state.players[0].socketId;
          }
          const aborted = abortGameIfLowPlayers(r, roomIdSnapshot);
          if (!aborted) startServerTurnTimer(roomIdSnapshot);
          emitRoomState(roomIdSnapshot);
        }
      }, timeoutSecs * 1000);
    }
  };

  socket.on('leaveRoom', () => {
    if (currentRoom) socket.leave(currentRoom);
    handlePlayerLeave(true);
    currentRoom = null;
    username = null;
  });

  socket.on('disconnect', () => {
    handlePlayerLeave(false);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// VITE_API_TOKEN guards the HTTP POST /api/stats/* endpoints (admin/tool access only).
// Clients submit stats via authenticated WebSocket events — no token in the client bundle.
if (process.env.NODE_ENV === 'production' && !process.env.VITE_API_TOKEN) {
  console.error('[SECURITY] VITE_API_TOKEN is not set. Refusing to start in production.');
  process.exit(1);
}
const API_TOKEN = process.env.VITE_API_TOKEN || 'tutto-local-dev-token';

const requireToken = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void => {
  if (req.headers['x-tutto-token'] !== API_TOKEN) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
};

// Client crash reports from the ErrorBoundary (see src/utils/crashLog.ts).
// Unauthenticated by design — crash reporting must work for any player — so
// the payload is strictly truncated and only ever logged, never stored or
// echoed back. express.json() already caps the body size at its default limit.
const CRASH_FIELD_MAX = 2000;
app.post('/api/log/client-error', (req: express.Request, res: express.Response) => {
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const field = (key: string): string => String(body[key] ?? '').slice(0, CRASH_FIELD_MAX);
  console.error(
    `[client-error] ${field('timestamp') || new Date().toISOString()} ${field('message')}\n` +
    `stack: ${field('stack')}\ncomponentStack: ${field('componentStack')}`
  );
  res.json({ success: true });
});

app.get('/api/stats/global', async (_req: express.Request, res: express.Response) => {
  try {
    const stats = await getGlobalStats();
    res.json(stats ?? {});
  } catch (err) {
    console.error('DB error in global GET:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/stats/global', requireToken, async (req: express.Request, res: express.Response) => {
  try {
    await updateGlobalStats(sanitizeStats(req.body));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/stats/:deviceId', async (req: express.Request, res: express.Response) => {
  try {
    const stats = await getDeviceStats(req.params.deviceId as string);
    res.json(stats ?? {});
  } catch (err) {
    console.error('DB error in device GET:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/stats/:deviceId', requireToken, async (req: express.Request, res: express.Response) => {
  try {
    await updateDeviceStats(req.params.deviceId as string, sanitizeStats(req.body));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.use((_req: express.Request, res: express.Response) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'), (err: Error | null) => {
    if (err) res.status(404).send('Not found');
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
