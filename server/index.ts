import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env') });

import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { sanitizeStats } from './sanitize';
import { DEFAULT_RECONNECT_TIMEOUT } from '../src/utils/configValidation';
import { applyValidatedConfig, applyPushedState } from './pushValidation';
import { clearServerTurnTimer, startServerTurnTimer, abortGameIfLowPlayers } from './turnTimers';
import type { ServerPlayer } from './roomTypes';
import { rooms, createRoom, handleActivePlayerRemoved, emitRoomState } from './rooms';
import playerColorsData from '../playerColors.json';
const { PLAYER_COLORS } = playerColorsData;

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
      // handlePlayerLeave reads `currentRoom` from the closure internally
      // (emitRoomState, delete rooms[currentRoom], etc.) — null it out only AFTER.
      handlePlayerLeave(true);
      currentRoom = null;
      username = null;
    }

    if (!rooms[roomId]) {
      rooms[roomId] = createRoom(socket.id);

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
      emitRoomState(io, roomId);
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
    emitRoomState(io, roomId);
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
    startServerTurnTimer(io, roomId);
    emitRoomState(io, roomId);
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
      emitRoomState(io, roomId);
    }
  });

  socket.on('updatePlayerColor', ({ roomId, color }: { roomId: string; color: string }) => {
    if (!rooms[roomId]) return;
    const colorRe = /^#[0-9a-fA-F]{6}$/i;
    if (!color || !colorRe.test(color)) return;
    const player = rooms[roomId].state.players.find(p => p.socketId === socket.id);
    if (player) {
      player.color = color;
      emitRoomState(io, roomId);
    }
  });

  socket.on('kickPlayer', (targetSocketId: string) => {
    if (!currentRoom || !rooms[currentRoom] || rooms[currentRoom].host !== socket.id) return;
    const room = rooms[currentRoom];

    io.to(targetSocketId).emit('kicked');

    const removedIdx = room.state.players.findIndex(p => p.socketId === targetSocketId);
    if (removedIdx !== -1) {
      const removedPlayer = room.state.players[removedIdx];
      room.state.players.splice(removedIdx, 1);
      handleActivePlayerRemoved(room.state, removedIdx);
      // A kicked player may be mid-reconnect-countdown; leaving that timer armed
      // would later remove whoever rejoined the room on the same device.
      if (room.disconnectTimers[removedPlayer.deviceId]) {
        clearTimeout(room.disconnectTimers[removedPlayer.deviceId]);
        delete room.disconnectTimers[removedPlayer.deviceId];
      }
    }

    if (room.state.players.length === 0) {
      clearServerTurnTimer(currentRoom);
      delete rooms[currentRoom];
    } else {
      const aborted = abortGameIfLowPlayers(io, room, currentRoom);
      // If the kicked player was mid-turn, handleActivePlayerRemoved already
      // reset turnStartTime for the player now in their slot — resync the timer.
      if (!aborted) startServerTurnTimer(io, currentRoom);
      emitRoomState(io, currentRoom);
    }

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) targetSocket.leave(currentRoom);
  });

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

      // The host may legitimately reorder players (e.g. the random shuffle) only at
      // the moment the game starts. Outside that transition the server keeps its own
      // authoritative order so a stray push can never scramble the roster mid-game.
      // A game starts either from the lobby, or from the end screen's "Play Again",
      // which never passes through the lobby: the room is still status 'playing'
      // with finished=true when the host pushes the next game's opening state.
      const startingGame = isHost && newState.status === 'playing' &&
        (room.state.status === 'lobby' || (room.state.finished && newState.finished === false));
      if (startingGame) {
        room.statsRecordedForGame = { devices: new Set(), global: false };
      }

      applyPushedState(room.state, newState, { isHost, startingGame });

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
        startServerTurnTimer(io, roomId);
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

      emitRoomState(io, roomId);
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
        const aborted = abortGameIfLowPlayers(io, room, currentRoom);
        if (!aborted) startServerTurnTimer(io, currentRoom);
      }
      emitRoomState(io, currentRoom);
    } else {
      player.disconnected = true;
      emitRoomState(io, currentRoom);
      io.to(currentRoom).emit('playerDisconnected', username);

      if (!room.disconnectTimers) room.disconnectTimers = {};
      const timeoutSecs = room.state.reconnectTimeout ?? DEFAULT_RECONNECT_TIMEOUT;
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
        // This timer has fired — drop its bookkeeping entry, or the
        // "no pending timers" room-cleanup check above would see a phantom
        // pending timer forever and the room could never be deleted.
        delete r.disconnectTimers[player.deviceId];
        const removedIdx = r.state.players.findIndex(p => p.deviceId === player.deviceId);
        if (removedIdx === -1) return;
        r.state.players.splice(removedIdx, 1);
        handleActivePlayerRemoved(r.state, removedIdx);

        if (r.state.players.length === 0) {
          clearServerTurnTimer(roomIdSnapshot);
          delete rooms[roomIdSnapshot];
        } else {
          if (r.host === hostSocketId) {
            // Prefer a connected player — players[0] may itself be disconnected,
            // which would leave the room with a dead socket as host (no config /
            // kick / restart) until that player reconnects or times out. If
            // everyone left is disconnected, fall back to players[0]; their own
            // pending timers will resolve or clean up the room.
            const nextHost = r.state.players.find(p => !p.disconnected) ?? r.state.players[0];
            r.host = nextHost.socketId;
          }
          const aborted = abortGameIfLowPlayers(io, r, roomIdSnapshot);
          if (!aborted) startServerTurnTimer(io, roomIdSnapshot);
          emitRoomState(io, roomIdSnapshot);
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
