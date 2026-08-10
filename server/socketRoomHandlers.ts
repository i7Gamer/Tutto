import { v4 as uuidv4 } from 'uuid';
import { getDeviceStats } from './database';
import { DEFAULT_RECONNECT_TIMEOUT } from '../src/utils/configValidation';
import { zeroedPlayerStats } from '../src/utils/playerStats';
import { applyValidatedConfig } from './pushValidation';
import { startServerTurnTimer, abortGameIfLowPlayers } from './turnTimers';
import type { ServerPlayer } from './roomTypes';
import {
  rooms, createRoom, deleteRoom, handleActivePlayerRemoved, emitRoomState,
  MAX_PLAYERS_PER_ROOM, MAX_ROOMS,
} from './rooms';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';
import { assignPlayerColor } from './playerColor';

const JOIN_ROOM_LIMIT = { windowMs: 10_000, max: 10 };

/**
 * Taking a seat and giving it up: joining, leaving, dropping off.
 *
 * These three share handlePlayerLeave, which is why they are one module —
 * joining a different room has to vacate the old seat by exactly the same
 * route an explicit leave does.
 */
export const registerRoomHandlers = ({ io, socket, session }: SocketContext): void => {
  const joinRoomLimiter = createSocketEventLimiter(JOIN_ROOM_LIMIT);

  const handlePlayerLeave = (isExplicitLeave = false): void => {
    const currentRoom = session.roomId;
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
          // Intended policy: a host who EXPLICITLY leaves while no other
          // player is connected tears the room down immediately — even if
          // disconnected players still have reconnect timers pending. This
          // deliberately differs from a host DISCONNECT (the timeout path
          // below keeps the room alive so the others can reconnect into
          // it): leaving is a conscious act of abandoning the room, not an
          // accident to recover from. The 'kicked' emits are best-effort
          // (the targets are disconnected, so usually no-ops) and
          // deleteRoom cancels the pending timers.
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
      io.to(currentRoom).emit('playerDisconnected', session.username);

      const timeoutSecs = room.state.reconnectTimeout ?? DEFAULT_RECONNECT_TIMEOUT;
      if (timeoutSecs === 0) {
        if (room.state.players.every(p => p.disconnected)) {
          deleteRoom(currentRoom);
        }
        return;
      }

      const roomIdSnapshot = currentRoom;
      const disconnectedSocketId = socket.id;

      const timerScale = process.env.TEST_TIMER_SCALE ? parseFloat(process.env.TEST_TIMER_SCALE) : 1;
      const disconnectMs = Math.max(10, Math.floor(timeoutSecs * 1000 * timerScale));
      room.disconnectTimers[player.deviceId] = setTimeout(() => {
        // Same backstop advanceTurnOnTimeout carries, for the same reason:
        // this runs off a bare setTimeout with no caller to catch a throw, so
        // an exception here would end the process (every room, every player)
        // rather than just this one seat's cleanup. safeOn covers the socket
        // listeners; a timer callback has to guard itself.
        try {
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
        } catch (err) {
          console.error(`[disconnectTimer] Failed to remove a timed-out player from room ${roomIdSnapshot}:`, err);
        }
      }, disconnectMs);
    }
  };

  safeOn(socket, 'joinRoom', async (
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
    // between a check and the mutation it guards. Fetching the streaks needs
    // only the deviceId, so hoisting it here costs nothing — when it sat
    // mid-handler it opened two real races: a pending disconnect-timeout
    // could fire mid-await and splice the very seat being rejoined (the
    // handler then mutated a dead object and acked success against a
    // deleted room), and two interleaved fresh joins from one device could
    // both pass the one-room-per-device check before either had seated
    // itself. BOTH rulesets' streaks come from this single await (the room —
    // and with it the ruleset — may not even exist yet, and a lobby toggle
    // would stale a single fetch anyway); the client badge picks the one
    // matching the synced ruleset.
    let winStreak = 0;
    let winStreakClassic = 0;
    try {
      const [normalizedStats, classicStats] = await Promise.all([
        getDeviceStats(deviceId, 'normalized'),
        getDeviceStats(deviceId, 'classic'),
      ]);
      winStreak = normalizedStats?.currentWinStreak ?? 0;
      winStreakClassic = classicStats?.currentWinStreak ?? 0;
    } catch (err) {
      console.error('[joinRoom] getDeviceStats error:', err);
    }

    // The await above is also the one window in which this socket can die
    // mid-handler — and its 'disconnect' event cleans up nothing: a fresh
    // join has no session.roomId yet, and a rejoin's seat still carries the
    // OLD socketId. Everything below would then seat a dead socket marked
    // connected: an undeletable ghost room per scripted join-and-close, or a
    // phantom seat whose pending reconnect timer gets cancelled right here.
    // Nothing after this point awaits, so one re-check closes the window.
    if (!socket.connected) {
      return callback({ success: false, error: 'Disconnected' });
    }

    // A socket may only be an active member of one room at a time. Without this,
    // joining a second, different room without leaving the first leaves a ghost
    // player entry behind forever (the session's room is just overwritten below) —
    // an unbounded way to accumulate abandoned rooms.
    if (session.roomId && session.roomId !== roomId) {
      socket.leave(session.roomId);
      // handlePlayerLeave reads the room off the session itself
      // (emitRoomState, delete rooms[...], etc.) — clear it only AFTER.
      handlePlayerLeave(true);
      session.roomId = null;
      session.username = null;
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
      // Refuse to CREATE past the cap — joins and reconnects into existing
      // rooms are unaffected (they don't grow the room count). See MAX_ROOMS
      // in rooms.ts for why the count must be bounded.
      if (Object.keys(rooms).length >= MAX_ROOMS) {
        return callback({ success: false, error: 'Server is full. Try again later.' });
      }
      rooms[roomId] = createRoom(socket.id);

      if (initialConfig && typeof initialConfig === 'object') {
        applyValidatedConfig(rooms[roomId].state, initialConfig);
      }
    }

    const room = rooms[roomId];

    const existingPlayer = room.state.players.find(p => p.deviceId === deviceId);
    if (existingPlayer) {
      existingPlayer.winStreak = winStreak;
      existingPlayer.winStreakClassic = winStreakClassic;
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
      // A same-device takeover (second tab, reopened app) supersedes the old
      // socket — remove it from the Socket.IO room like kickPlayer does, or
      // the abandoned tab keeps receiving every broadcast forever; if this
      // roomId is later deleted and reused by strangers, that tab would
      // silently stream THEIR room state too.
      if (existingPlayer.socketId && existingPlayer.socketId !== socket.id) {
        io.sockets.sockets.get(existingPlayer.socketId)?.leave(roomId);
      }
      if (room.host === existingPlayer.socketId) room.host = socket.id;
      existingPlayer.socketId = socket.id;
      existingPlayer.disconnected = false;

      if (room.disconnectTimers[deviceId]) {
        clearTimeout(room.disconnectTimers[deviceId]);
        delete room.disconnectTimers[deviceId];
      }

      socket.join(roomId);
      session.roomId = roomId;
      session.username = name;
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

    session.roomId = roomId;
    session.username = name;

    const newPlayer: ServerPlayer = {
      id: uuidv4(),
      name,
      deviceId,
      socketId: socket.id,
      ...zeroedPlayerStats(),
      position: 0,
      color: assignPlayerColor(color, room.state.players.map(p => p.color)),
      disconnected: false,
      winStreak,
      winStreakClassic,
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

  safeOn(socket, 'leaveRoom', () => {
    if (session.roomId) socket.leave(session.roomId);
    handlePlayerLeave(true);
    session.roomId = null;
    session.username = null;
  });

  safeOn(socket, 'disconnect', () => {
    handlePlayerLeave(false);
  });
};
