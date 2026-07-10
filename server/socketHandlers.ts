import { Server, Socket } from 'socket.io';
import { getDeviceStats, updateDeviceStats, updateGlobalStats } from './database';
import { sanitizeStats } from './sanitize';
import { DEFAULT_RECONNECT_TIMEOUT } from '../src/utils/configValidation';
import { REACTION_EMOJIS } from '../src/utils/reactions';
import type { DiceMode } from '../src/types';
import { applyValidatedConfig, applyPushedState, isValidDiceSnapshot, sanitizeDiceSnapshot } from './pushValidation';
import { clearServerTurnTimer, startServerTurnTimer, abortGameIfLowPlayers } from './turnTimers';
import type { ServerPlayer } from './roomTypes';
import { rooms, createRoom, deleteRoom, handleActivePlayerRemoved, emitRoomState, MAX_PLAYERS_PER_ROOM } from './rooms';
import { createSocketEventLimiter } from './rateLimit';
import playerColorsData from '../playerColors.json';
const { PLAYER_COLORS } = playerColorsData;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/i;

// Per-connection event caps — generous enough for the fastest legitimate
// cadence of each event (e.g. liveTurnState fires ~every 300ms while a
// player is rolling) while still bounding a scripted/malicious flood. Each
// socket gets its own limiter instances (see createSocketEventLimiter).
const JOIN_ROOM_LIMIT = { windowMs: 10_000, max: 10 };
const PUSH_STATE_LIMIT = { windowMs: 1_000, max: 20 };
const UPDATE_CONFIG_LIMIT = { windowMs: 1_000, max: 20 };
const KICK_PLAYER_LIMIT = { windowMs: 1_000, max: 5 };
const LIVE_TURN_STATE_LIMIT = { windowMs: 1_000, max: 15 };
const SUBMIT_GLOBAL_STATS_LIMIT = { windowMs: 10_000, max: 5 };
const END_GAME_STATS_LIMIT = { windowMs: 10_000, max: 5 };
// Reordering is a discrete button click in the lobby — same cap as kicking.
const REORDER_PLAYERS_LIMIT = { windowMs: 1_000, max: 5 };
// The color picker fires continuously while dragging (React onChange maps to
// the native input event) — same generous cap as the other continuous-UI
// events (pushState/updateConfig).
const UPDATE_PLAYER_COLOR_LIMIT = { windowMs: 1_000, max: 20 };
// One reaction per second per connection — a deliberate UX pace, not just
// abuse protection, so it uses the same limiter mechanism as every other
// event instead of the ad-hoc timestamp cooldown it replaced.
const SEND_REACTION_LIMIT = { windowMs: 1_000, max: 1 };

export const registerSocketHandlers = (io: Server): void => {
  io.on('connection', (socket: Socket) => {
    let currentRoom: string | null = null;
    let username: string | null = null;

    const joinRoomLimiter = createSocketEventLimiter(JOIN_ROOM_LIMIT);
    const pushStateLimiter = createSocketEventLimiter(PUSH_STATE_LIMIT);
    const updateConfigLimiter = createSocketEventLimiter(UPDATE_CONFIG_LIMIT);
    const kickPlayerLimiter = createSocketEventLimiter(KICK_PLAYER_LIMIT);
    const liveTurnStateLimiter = createSocketEventLimiter(LIVE_TURN_STATE_LIMIT);
    const submitGlobalStatsLimiter = createSocketEventLimiter(SUBMIT_GLOBAL_STATS_LIMIT);
    const endGameStatsLimiter = createSocketEventLimiter(END_GAME_STATS_LIMIT);
    const reorderPlayersLimiter = createSocketEventLimiter(REORDER_PLAYERS_LIMIT);
    const updatePlayerColorLimiter = createSocketEventLimiter(UPDATE_PLAYER_COLOR_LIMIT);
    const sendReactionLimiter = createSocketEventLimiter(SEND_REACTION_LIMIT);

    socket.on('joinRoom', async (
      payload: { roomId?: string; name?: string; deviceId?: string; color?: string; initialConfig?: Record<string, unknown> } | null | undefined,
      callback: (result: { success: boolean; isHost?: boolean; socketId?: string; error?: string; name?: string }) => void
    ) => {
      // Reject malformed payloads before any field is used. Without these guards a
      // client that omits the ack callback or sends a non-string name crashes the
      // handler (e.g. name.toLowerCase() throws), which can take down the server.
      if (typeof callback !== 'function') return;
      if (!joinRoomLimiter()) return callback({ success: false, error: 'Too many requests' });
      if (!payload || typeof payload !== 'object') {
        return callback({ success: false, error: 'Invalid payload' });
      }
      const { roomId, name: rawName, deviceId, color, initialConfig } = payload;
      if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 100) {
        return callback({ success: false, error: 'Invalid room' });
      }
      if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 200) {
        return callback({ success: false, error: 'Invalid device' });
      }
      if (typeof rawName !== 'string') {
        return callback({ success: false, error: 'Invalid name' });
      }
      let name = rawName.trim();
      if (name.length === 0 || name.length > 30) {
        return callback({ success: false, error: 'Invalid name' });
      }

      // The ONLY await in this handler, done before any room state is read or
      // mutated: everything below runs synchronously, so no other event (a
      // concurrent join, a disconnect-timeout timer, a kick) can interleave
      // between a check and the mutation it guards. Fetching the streak needs
      // only the deviceId, so hoisting it here costs nothing — when it sat
      // mid-handler it opened two real races: a pending disconnect-timeout
      // could fire mid-await and splice the very seat being rejoined (the
      // handler then mutated a dead object and acked success against a
      // deleted room), and two interleaved fresh joins from one device could
      // both pass the one-room-per-device check before either had seated
      // itself.
      let winStreak = 0;
      try {
        const stats = await getDeviceStats(deviceId);
        winStreak = stats?.currentWinStreak ?? 0;
      } catch (err) {
        console.error('[joinRoom] getDeviceStats error:', err);
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

      // A single device may hold a seat in at most one room at a time — without
      // this, the same deviceId (e.g. two open tabs, or a scripted client) could
      // create or join an unbounded number of rooms. Checked live against `rooms`
      // rather than a separate cache, so it can never go stale: a room being
      // deleted or a player being removed is immediately reflected here, with no
      // extra bookkeeping to keep in sync. Excludes `roomId` itself so a
      // reconnect/rejoin into the SAME room (handled below) is unaffected.
      const otherRoomId = Object.keys(rooms).find(id =>
        id !== roomId && rooms[id].state.players.some(p => p.deviceId === deviceId)
      );
      if (otherRoomId) {
        return callback({ success: false, error: 'This device is already in another room. Leave it before joining a new one.' });
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
        existingPlayer.winStreak = winStreak;
        if (room.state.status === 'lobby') {
          // Disconnected players keep their name reserved too (same rule as the
          // fresh-join path below) — otherwise a rejoining device could rename
          // itself to a disconnected player's name, and the room would hold two
          // identical names once that player reconnects. Names are the identity
          // key for pushState merging, so duplicates corrupt scores and stats.
          const nameTakenByOther = room.state.players.some(
            p => p.deviceId !== deviceId && p.name.toLowerCase() === name.toLowerCase()
          );
          if (nameTakenByOther) {
            return callback({ success: false, error: 'Username already exists in this room' });
          }
          existingPlayer.name = name;
        } else {
          // Renames are only honored in the lobby. Mid-game, other clients'
          // in-flight pushStates still carry the old name (failing the player
          // merge until the next broadcast) and chartNames would go stale — so
          // the rejoin keeps the seat's existing name, returned via the ack so
          // the client adopts it instead of keeping a mismatched myName.
          name = existingPlayer.name;
        }
        if (room.host === existingPlayer.socketId) room.host = socket.id;
        existingPlayer.socketId = socket.id;
        existingPlayer.disconnected = false;

        if (room.disconnectTimers[deviceId]) {
          clearTimeout(room.disconnectTimers[deviceId]);
          delete room.disconnectTimers[deviceId];
        }

        socket.join(roomId);
        currentRoom = roomId;
        username = name;
        callback({ success: true, isHost: room.host === socket.id, socketId: socket.id, name });
        emitRoomState(io, roomId);
        return;
      }

      if (room.state.status !== 'lobby') {
        return callback({ success: false, error: 'Game is already running. You cannot join mid-game.' });
      }

      if (room.state.players.length >= MAX_PLAYERS_PER_ROOM) {
        return callback({ success: false, error: 'Room is full' });
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

      currentRoom = roomId;
      username = name;

      let assignedColor: string | null = (typeof color === 'string' && COLOR_RE.test(color)) ? color : null;
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
        winStreak,
      };
      room.state.players.push(newPlayer);
      // Joined only now that the player is already in room.state.players — a
      // socket must never be in the Socket.IO room while absent from the
      // roster, or a concurrent broadcast (e.g. another player's pushState)
      // would reach it showing a player list that doesn't include itself.
      socket.join(roomId);

      callback({ success: true, isHost: room.host === socket.id, socketId: socket.id, name });
      emitRoomState(io, roomId);
    });

    socket.on('updateConfig', (data: {
      roomId?: string;
      winningScore?: number;
      initialCards?: unknown;
      randomOrder?: boolean;
      turnDuration?: number;
      reconnectTimeout?: number;
      enforcedDiceMode?: DiceMode | null;
    } | null | undefined) => {
      if (!updateConfigLimiter()) return;
      if (!data || typeof data !== 'object') return;
      const { roomId, winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout, enforcedDiceMode } = data;
      if (typeof roomId !== 'string' || !rooms[roomId] || rooms[roomId].host !== socket.id) return;
      applyValidatedConfig(rooms[roomId].state, { winningScore, initialCards, randomOrder, turnDuration, reconnectTimeout, enforcedDiceMode });
      // Resync the pending expiry to the (possibly just-changed) turnDuration. A
      // no-op if no turn is in progress; startServerTurnTimer's own guards handle that.
      startServerTurnTimer(io, roomId);
      emitRoomState(io, roomId);
    });

    socket.on('reorderPlayers', (data: { roomId?: string; newPlayers?: { name: string }[] } | null | undefined) => {
      if (!reorderPlayersLimiter()) return;
      if (!data || typeof data !== 'object') return;
      const { roomId, newPlayers } = data;
      if (typeof roomId !== 'string' || !rooms[roomId] || rooms[roomId].host !== socket.id) return;
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

    socket.on('updatePlayerColor', (data: { roomId?: string; color?: string } | null | undefined) => {
      if (!updatePlayerColorLimiter()) return;
      if (!data || typeof data !== 'object') return;
      const { roomId, color } = data;
      if (typeof roomId !== 'string' || typeof color !== 'string') return;
      if (!rooms[roomId]) return;
      if (!COLOR_RE.test(color)) return;
      const player = rooms[roomId].state.players.find(p => p.socketId === socket.id);
      if (player) {
        player.color = color;
        emitRoomState(io, roomId);
      }
    });

    socket.on('sendReaction', (data: { emoji?: string } | null | undefined) => {
      if (!sendReactionLimiter()) return;
      if (!data || typeof data !== 'object') return;
      const { emoji } = data;
      // Uses `currentRoom` (this socket's own tracked room) rather than a
      // client-supplied roomId — a reaction only ever needs to broadcast to
      // the room this socket is actually seated in.
      if (!currentRoom || !rooms[currentRoom]) return;
      if (typeof emoji !== 'string' || !(REACTION_EMOJIS as readonly string[]).includes(emoji)) return;

      const room = rooms[currentRoom];
      const sender = room.state.players.find(p => p.socketId === socket.id);
      if (!sender) return;
      io.to(currentRoom).emit('playerReaction', {
        id: Date.now() + Math.random(),
        emoji,
        senderName: sender.name,
        senderColor: sender.color,
      });
    });

    socket.on('kickPlayer', (targetSocketId: string) => {
      if (!kickPlayerLimiter()) return;
      if (typeof targetSocketId !== 'string') return;
      if (!currentRoom || !rooms[currentRoom] || rooms[currentRoom].host !== socket.id) return;
      const room = rooms[currentRoom];

      const removedIdx = room.state.players.findIndex(p => p.socketId === targetSocketId);
      if (removedIdx !== -1) {
        // Only emit once the target is confirmed to be in the host's own room —
        // otherwise a host could send a 'kicked' signal to any socket on the
        // server, booting players out of unrelated rooms client-side.
        io.to(targetSocketId).emit('kicked');
        const removedPlayer = room.state.players[removedIdx];
        room.state.players.splice(removedIdx, 1);
        handleActivePlayerRemoved(room, removedIdx);
        // A kicked player may be mid-reconnect-countdown; leaving that timer armed
        // would later remove whoever rejoined the room on the same device.
        if (room.disconnectTimers[removedPlayer.deviceId]) {
          clearTimeout(room.disconnectTimers[removedPlayer.deviceId]);
          delete room.disconnectTimers[removedPlayer.deviceId];
        }
      }

      if (room.state.players.length === 0) {
        deleteRoom(currentRoom);
      } else {
        // Only a (modified) host client can kick its own socket, but if it does,
        // the room must not keep a host id that is no longer seated — no one
        // could change config, kick, or restart until the room died.
        if (!room.state.players.some(p => p.socketId === room.host)) {
          const nextHost = room.state.players.find(p => !p.disconnected) ?? room.state.players[0];
          room.host = nextHost.socketId;
        }
        const aborted = abortGameIfLowPlayers(io, room, currentRoom);
        // If the kicked player was mid-turn, handleActivePlayerRemoved already
        // reset turnStartTime for the player now in their slot — resync the timer.
        if (!aborted) startServerTurnTimer(io, currentRoom);
        emitRoomState(io, currentRoom);
      }

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) targetSocket.leave(currentRoom);
    });

    socket.on('pushState', (data: { roomId?: string; newState?: Record<string, unknown> } | null | undefined) => {
      try {
        if (!pushStateLimiter()) return;
        if (!data || typeof data !== 'object') return;
        const { roomId, newState } = data;
        if (typeof roomId !== 'string' || !newState || typeof newState !== 'object') return;
        const room = rooms[roomId];
        if (!room) return;

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
        console.error(`[pushState] Failed to apply state for room:`, err);
      }
    });

    // Dedicated low-overhead path for live dice-roll updates (fired ~every
    // 300ms while a player is rolling). Deliberately separate from pushState:
    // that handler re-serializes and broadcasts the ENTIRE room snapshot
    // (players, historyLog, chart arrays, ...) on every call via
    // emitRoomState, which is wasteful for an update where only
    // liveTurnState actually changed. This handler updates just that one
    // field and broadcasts a small, standalone event instead — pushState,
    // applyPushedState, and emitRoomState are untouched and still carry
    // liveTurnState as part of the full sync for reconnect/fresh-join.
    socket.on('liveTurnState', (data: { roomId?: string; liveTurnState?: unknown } | null | undefined) => {
      try {
        if (!liveTurnStateLimiter()) return;
        if (!data || typeof data !== 'object') return;
        const { roomId, liveTurnState } = data;
        if (typeof roomId !== 'string') return;
        const room = rooms[roomId];
        if (!room) return;

        const isHost = room.host === socket.id;
        const activePlayer = room.state.currentPlayerIndex !== null
          ? room.state.players[room.state.currentPlayerIndex]
          : null;
        const isActivePlayer = activePlayer?.socketId === socket.id;

        if (!isHost && !isActivePlayer) return;

        if (liveTurnState === null) {
          room.state.liveTurnState = null;
        } else if (isValidDiceSnapshot(liveTurnState)) {
          room.state.liveTurnState = sanitizeDiceSnapshot(liveTurnState);
        } else {
          return;
        }

        io.to(roomId).emit('liveTurnState', { liveTurnState: room.state.liveTurnState });
      } catch (err) {
        console.error(`[liveTurnState] Failed to apply live turn state for room:`, err);
      }
    });

    socket.on('submitGlobalStats', async (data: { roomId?: string; payload?: unknown } | null | undefined) => {
      if (!submitGlobalStatsLimiter()) return;
      if (!data || typeof data !== 'object') return;
      const { roomId, payload } = data;
      if (typeof roomId !== 'string') return;
      // Only the room host may submit global stats, authenticated by socket identity.
      // No token needed — the WebSocket session is the credential.
      const room = rooms[roomId];
      if (!room || room.host !== socket.id) return;
      // A reconnect/reload after the game already finished (but before anyone
      // leaves the room) makes the client think "finished just became true" again,
      // re-submitting for the same game. Recorded per game, reset when a new one
      // starts (see pushState's startingGame branch).
      if (room.statsRecordedForGame.global) return;
      // Marked BEFORE the await so a concurrent duplicate can't slip through,
      // but rolled back on failure — otherwise a transient DB error would
      // permanently swallow this game's stats (the dedup would reject a retry).
      room.statsRecordedForGame.global = true;
      try {
        await updateGlobalStats(sanitizeStats(payload));
      } catch (err) {
        room.statsRecordedForGame.global = false;
        console.error('submitGlobalStats error:', err);
      }
    });

    socket.on('endGameStats', async (data: { deviceId?: string; stats?: unknown } | null | undefined) => {
      if (!endGameStatsLimiter()) return;
      if (!data || typeof data !== 'object') return;
      const { deviceId, stats } = data;
      if (typeof deviceId !== 'string') return;
      // A socket may only submit stats for its OWN device, and only while it is a
      // member of its current room. This mirrors the token gate on the HTTP path
      // (POST /api/stats/:deviceId) so the socket route can't be used to write
      // arbitrary device statistics.
      const room = currentRoom ? rooms[currentRoom] : null;
      const player = room?.state.players.find(p => p.socketId === socket.id);
      if (!player || player.deviceId !== deviceId || !room) return;
      // See submitGlobalStats above — same reconnect-after-finish dedup, per device.
      if (room.statsRecordedForGame.devices.has(deviceId)) return;
      // See submitGlobalStats: pre-add blocks concurrent duplicates, rollback
      // on failure keeps a retry possible instead of losing the game's stats.
      room.statsRecordedForGame.devices.add(deviceId);
      try {
        await updateDeviceStats(deviceId, sanitizeStats(stats));
        // The win/loss just recorded above may have changed this device's streak.
        // `player` still holds the value from when they joined, so without this
        // refresh + broadcast, the streak shown next to the player (leaderboard,
        // spectators) stays stale until they rejoin a room.
        const updatedStats = await getDeviceStats(deviceId);
        player.winStreak = updatedStats?.currentWinStreak ?? 0;
        emitRoomState(io, currentRoom as string);
      } catch (err) {
        room.statsRecordedForGame.devices.delete(deviceId);
        console.error('[endGameStats] error:', err);
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
        handleActivePlayerRemoved(room, playerIndex);

        if (room.disconnectTimers[player.deviceId]) {
          clearTimeout(room.disconnectTimers[player.deviceId]);
          delete room.disconnectTimers[player.deviceId];
        }

        if (room.state.players.length === 0) {
          deleteRoom(currentRoom);
          return;
        } else if (room.host === socket.id) {
          const nextHost = room.state.players.find(p => !p.disconnected);
          if (!nextHost) {
            for (const p of room.state.players) {
              io.to(p.socketId).emit('kicked');
            }
            deleteRoom(currentRoom);
            return;
          }
          room.host = nextHost.socketId;
        } else if (
          room.state.players.every(p => p.disconnected) &&
          Object.keys(room.disconnectTimers).length === 0
        ) {
          // All remaining players are disconnected with no reconnect timers
          // (e.g. reconnectTimeout=0). The room would never be cleaned up otherwise.
          deleteRoom(currentRoom);
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

        const timeoutSecs = room.state.reconnectTimeout ?? DEFAULT_RECONNECT_TIMEOUT;
        if (timeoutSecs === 0) {
          if (room.state.players.every(p => p.disconnected)) {
            deleteRoom(currentRoom);
          }
          return;
        }

        const roomIdSnapshot = currentRoom;
        const disconnectedSocketId = socket.id;

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
          handleActivePlayerRemoved(r, removedIdx);

          if (r.state.players.length === 0) {
            deleteRoom(roomIdSnapshot);
          } else {
            if (r.host === disconnectedSocketId) {
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
};
