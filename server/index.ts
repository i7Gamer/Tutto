import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { sanitizeStats } from './sanitize';
import type { DiceSnapshot } from '../src/types';
import playerColorsData from '../playerColors.json';

const { PLAYER_COLORS } = playerColorsData;

// ─── Types ────────────────────────────────────────────────────────────────────

type CardType =
  | 'Kleeblatt' | 'Feuerwerk' | 'Stop' | 'Kniffel' | 'Plus_Minus'
  | 'x2' | '200' | '300' | '400' | '500' | '600';

interface ServerPlayer {
  name: string;
  deviceId: string;
  socketId: string;
  score: number;
  times1000PointsDeducted: number;
  timesKniffelCompleted: number;
  timesPlusMinusCompleted: number;
  timesKniffelFailed: number;
  timesKleeblattFailed: number;
  timesKleeblattCompleted: number;
  timesPlusMinusFailed: number;
  timesFeuerwerkReceived: number;
  timesSkipped: number;
  timesx2Received: number;
  totalTurns: number;
  busts: number;
  feuerwerkBusts: number;
  x2Busts: number;
  feuerwerkPointsScored: number;
  x2PointsScored: number;
  position: number;
  color: string;
  disconnected: boolean;
  highestTurnScore?: number;
}

interface RoomState {
  players: ServerPlayer[];
  status: 'lobby' | 'playing';
  initialCards: Partial<Record<CardType, number>>;
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
  chartLabels: string[];
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

interface Room {
  host: string;
  state: RoomState;
  gameActualStartTime: number | null;
  turnTimerState: TurnTimerState | null;
  disconnectTimers: Record<string, ReturnType<typeof setTimeout>>;
}

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 4000,
  pingTimeout: 6000,
});

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_CARD_TYPES = new Set<CardType>([
  'Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2',
  '200', '300', '400', '500', '600',
]);
const MAX_CARD_COUNT = 99;

const validateInitialCards = (cards: unknown): cards is Partial<Record<CardType, number>> => {
  if (typeof cards !== 'object' || cards === null) return false;
  const entries = Object.entries(cards as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([key, val]) =>
    VALID_CARD_TYPES.has(key as CardType) &&
    Number.isInteger(val) &&
    (val as number) >= 0 &&
    (val as number) <= MAX_CARD_COUNT
  );
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

const buildShuffledDeck = (initialCards: Partial<Record<CardType, number>>): CardType[] => {
  const deck: CardType[] = Object.entries(initialCards).reduce<CardType[]>((acc, [card, count]) => {
    for (let i = 0; i < (count ?? 0); i++) acc.push(card as CardType);
    return acc;
  }, []);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

const drawNextCardForRoom = (state: RoomState): void => {
  if (state.cards && state.cards.length > 0) {
    state.currentCard = state.cards.shift() ?? null;
  } else {
    const deck = buildShuffledDeck(state.initialCards);
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
    state.currentPlayerIndex = curIdx % Math.max(1, state.players.length);
    state.previousCard = null;
    state.previousScore = null;
    state.previousLeaders = null;
    state.round += 1;
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

  let multiplier = 1;
  if (room.state.currentCard === 'Feuerwerk') multiplier = 3;
  if (room.state.currentCard === 'Kleeblatt') multiplier = 2;
  const targetDuration = room.state.turnDuration * multiplier;
  const elapsedSeconds = Math.floor((Date.now() - room.state.turnStartTime) / 1000);
  return Math.max(0, targetDuration - elapsedSeconds);
};

const emitRoomState = (roomId: string): void => {
  const room = rooms[roomId];
  if (!room) return;
  const gameState = {
    ...room.state,
    turnTimeRemaining: calculateRemainingTurnTime(room),
    gameTimeInSeconds: calculateGameTime(room),
  };
  io.to(roomId).emit('gameState', gameState);
  io.to(roomId).emit('hostId', room.host);
};

const abortGameIfLowPlayers = (room: Room, roomId: string): boolean => {
  if (room.state.status === 'playing' && room.state.players.length < 2) {
    io.to(roomId).emit('gameAborted');
    room.state.status = 'lobby';
    room.state.currentCard = null;
    room.state.currentPlayerIndex = null;
    room.state.finished = false;
    return true;
  }
  return false;
};

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket: Socket) => {
  let currentRoom: string | null = null;
  let username: string | null = null;

  socket.on('joinRoom', (
    { roomId, name, deviceId, color }: { roomId: string; name: string; deviceId: string; color?: string } =
      {} as { roomId: string; name: string; deviceId: string; color?: string },
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

    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: socket.id,
        gameActualStartTime: null,
        turnTimerState: null,
        disconnectTimers: {},
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
    }

    const room = rooms[roomId];

    const existingPlayer = room.state.players.find(p => p.deviceId === deviceId);
    if (existingPlayer) {
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

    if (room.state.players.find(p => p.name.toLowerCase() === name.toLowerCase())) {
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
    const s = rooms[roomId].state;
    if (typeof winningScore === 'number' && winningScore >= 1000 && winningScore <= 99999) s.winningScore = winningScore;
    if (validateInitialCards(initialCards)) s.initialCards = initialCards;
    if (typeof randomOrder === 'boolean') s.randomOrder = randomOrder;
    if (typeof turnDuration === 'number' && (turnDuration === 0 || (turnDuration >= 10 && turnDuration <= 600))) s.turnDuration = turnDuration;
    if (typeof reconnectTimeout === 'number' && (reconnectTimeout === 0 || (reconnectTimeout >= 10 && reconnectTimeout <= 3600))) s.reconnectTimeout = reconnectTimeout;
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
      delete rooms[currentRoom];
    } else {
      abortGameIfLowPlayers(room, currentRoom);
      emitRoomState(currentRoom);
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) targetSocket.leave(currentRoom);
  });

  const validatePushedPlayers = (existing: ServerPlayer[], pushed: unknown[]): boolean => {
    if (!Array.isArray(pushed) || pushed.length !== existing.length) return false;
    const existingIds = new Set(existing.map(p => p.deviceId));
    return pushed.every(p => typeof p === 'object' && p !== null && existingIds.has((p as { deviceId?: string }).deviceId ?? ''));
  };

  socket.on('pushState', ({ roomId, newState }: { roomId: string; newState: Record<string, unknown> }) => {
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

    const mergeMutable = (existing: ServerPlayer, p: Record<string, unknown> | undefined): ServerPlayer => {
      if (!p) return existing;
      const updated = { ...existing };
      for (const f of PLAYER_MUTABLE) {
        if (f in p) (updated as Record<string, unknown>)[f] = p[f];
      }
      return updated;
    };

    for (const key of allowedFields) {
      if (!(key in newState)) continue;
      if (key === 'players') {
        const pushed = newState.players as Record<string, unknown>[];
        if (!validatePushedPlayers(room.state.players, pushed)) continue;

        const pushedIds = pushed.map(p => p.deviceId as string);
        const isStrictPermutation = new Set(pushedIds).size === room.state.players.length;

        if (startingGame && isStrictPermutation) {
          // Adopt the host's chosen ordering, but keep the server-side player
          // identities and non-mutable fields. Keeps chartNames/chartValues
          // (pushed in the same order) aligned with the authoritative roster.
          const byDeviceId = new Map(room.state.players.map(p => [p.deviceId, p]));
          room.state.players = pushedIds.map(id =>
            mergeMutable(byDeviceId.get(id)!, pushed.find(q => q.deviceId === id)),
          );
        } else {
          room.state.players = room.state.players.map(existing =>
            mergeMutable(existing, pushed.find(q => q.deviceId === existing.deviceId)),
          );
        }
      } else {
        (room.state as unknown as Record<string, unknown>)[key] = newState[key];
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
    }

    if (room.state.finished || room.state.status === 'lobby') {
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
    if (!player || player.deviceId !== deviceId) return;
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
        delete rooms[currentRoom];
        return;
      } else if (room.host === socket.id) {
        const nextHost = room.state.players.find(p => !p.disconnected);
        if (!nextHost) {
          for (const p of room.state.players) {
            io.to(p.socketId).emit('kicked');
          }
          delete rooms[currentRoom];
          return;
        }
        room.host = nextHost.socketId;
      }
      abortGameIfLowPlayers(room, currentRoom);
      emitRoomState(currentRoom);
    } else {
      player.disconnected = true;
      emitRoomState(currentRoom);
      io.to(currentRoom).emit('playerDisconnected', username);

      if (!room.disconnectTimers) room.disconnectTimers = {};
      const timeoutSecs = room.state.reconnectTimeout ?? 60;
      if (timeoutSecs === 0) return;

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
          delete rooms[roomIdSnapshot];
        } else {
          if (r.host === hostSocketId) {
            r.host = r.state.players[0].socketId;
          }
          abortGameIfLowPlayers(r, roomIdSnapshot);
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
