import { v4 as uuidv4 } from 'uuid';
import { getDeviceStats } from './database';
import { DEFAULT_RECONNECT_TIMEOUT } from '../src/utils/configValidation';
import { zeroedPlayerStats } from '../src/utils/playerStats';
import { applyValidatedConfig } from './pushValidation';
import { startServerTurnTimer, abortGameIfLowPlayers, scaledTimerMs } from './turnTimers';
import type { ServerPlayer } from './roomTypes';
import {
  rooms, createRoom, deleteRoom, handleActivePlayerRemoved, emitRoomState,
  promoteHostAfterLoss, roomChannel, isAbandonedRoom, isAtRoomAddressCap,
  MAX_PLAYERS_PER_ROOM, MAX_ROOMS,
} from './rooms';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, getClientAddress, type SocketContext } from './socketContext';
import { assignPlayerColor } from './playerColor';

const JOIN_ROOM_LIMIT = { windowMs: 10_000, max: 10 };

/**
 * Why a joinRoom was refused, as a stable identifier rather than prose.
 *
 * The `error` sentences below are written here, in English, and the lobby used
 * to render them straight into its error box — so a German UI was told
 * "Username already exists in this room". These codes are what the client
 * translates (see JOIN_ERROR_KEYS in src/utils/joinErrors.ts, shared by the
 * lobby's error box, the restore-session popup and the auto-reconnect
 * handler); the prose rides along
 * unchanged as the fallback for a client that does not know a given code.
 * Renaming one is a breaking change for every deployed client — add, don't
 * rename.
 *
 * A runtime array with the union derived from it, rather than a bare type: a
 * type alone is erased at build time, so nothing could check that the client's
 * key table still covers every code — a thirteenth refusal added here
 * would ship untranslated in silence. `as const` keeps the union exactly as
 * narrow as the hand-written one was; the equality is asserted in
 * src/locales/translations.test.ts.
 */
export const JOIN_REFUSAL_CODES = [
  'rate_limited',
  'invalid_payload',
  'invalid_room',
  'invalid_device',
  'invalid_name',
  'disconnected',
  'device_in_other_room',
  'already_seated',
  'server_full',
  'name_taken',
  'game_running',
  'room_full',
  'too_many_rooms',
] as const;

type JoinRefusal = typeof JOIN_REFUSAL_CODES[number];

const refuse = (
  callback: (result: { success: boolean; error?: string; code?: JoinRefusal }) => void,
  code: JoinRefusal,
  error: string,
): void => callback({ success: false, code, error });

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
      } else if (isAbandonedRoom(room)) {
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

      const timeoutSecs = room.state.reconnectTimeout ?? DEFAULT_RECONNECT_TIMEOUT;
      // With the kick timer disabled no timer is armed, so the seat is never
      // freed automatically and the failover the timeout path does below never
      // runs — a host who drops would leave the room owned by a dead socket,
      // with nobody able to change config, kick the ghost, restart or submit
      // the game's stats, and no timer to recover it either. Decided BEFORE
      // the broadcast so clients learn the disconnect and the new owner from
      // one pair of events. Deliberately not done for a non-zero timeout: a
      // host who merely blinked gets their reconnect window first.
      if (timeoutSecs === 0 && !room.state.players.every(p => p.disconnected)) {
        promoteHostAfterLoss(room, socket.id);
      }

      emitRoomState(io, currentRoom);
      io.to(roomChannel(currentRoom)).emit('playerDisconnected', session.username);

      if (timeoutSecs === 0) {
        if (room.state.players.every(p => p.disconnected)) {
          deleteRoom(currentRoom);
        }
        return;
      }

      const roomIdSnapshot = currentRoom;
      const disconnectedSocketId = socket.id;

      const disconnectMs = scaledTimerMs(timeoutSecs);
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

          // isAbandonedRoom as well as the empty check: this timer may have been
          // the LAST one pending, and the seats it leaves behind can all be
          // timerless ghosts (a reconnectTimeout lowered to 0 after this timer
          // was armed does not retract it). Draining to that state is the one
          // way into an unfreeable room that the leave and kick paths cannot
          // see coming — at the moment they run, this timer is still pending
          // and the room is legitimately being held open for it.
          if (r.state.players.length === 0 || isAbandonedRoom(r)) {
            deleteRoom(roomIdSnapshot);
          } else {
            promoteHostAfterLoss(r, disconnectedSocketId);
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
    callback: (result: { success: boolean; isHost?: boolean; socketId?: string; error?: string; code?: JoinRefusal; name?: string }) => void
  ) => {
    // Reject malformed payloads before any field is used. Without these guards a
    // client that omits the ack callback or sends a non-string name crashes the
    // handler (e.g. name.toLowerCase() throws), which can take down the server.
    if (typeof callback !== 'function') return;
    if (!joinRoomLimiter()) return refuse(callback, 'rate_limited', 'Too many requests');
    if (!payload || typeof payload !== 'object') {
      return refuse(callback, 'invalid_payload', 'Invalid payload');
    }
    const { roomId, name: rawName, deviceId, color, initialConfig } = payload;
    if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > 100) {
      return refuse(callback, 'invalid_room', 'Invalid room');
    }
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 200) {
      return refuse(callback, 'invalid_device', 'Invalid device');
    }
    if (typeof rawName !== 'string') {
      return refuse(callback, 'invalid_name', 'Invalid name');
    }
    let name = rawName.trim();
    if (name.length === 0 || name.length > 30) {
      return refuse(callback, 'invalid_name', 'Invalid name');
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
      return refuse(callback, 'disconnected', 'Disconnected');
    }

    // A socket may only be an active member of one room at a time. Without this,
    // joining a second, different room without leaving the first leaves a ghost
    // player entry behind forever (the session's room is just overwritten below) —
    // an unbounded way to accumulate abandoned rooms.
    if (session.roomId && session.roomId !== roomId) {
      socket.leave(roomChannel(session.roomId));
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
      return refuse(callback, 'device_in_other_room', 'This device is already in another room. Leave it before joining a new one.');
    }

    if (!rooms[roomId]) {
      // Refuse to CREATE past the cap — joins and reconnects into existing
      // rooms are unaffected (they don't grow the room count). See MAX_ROOMS
      // in rooms.ts for why the count must be bounded.
      if (Object.keys(rooms).length >= MAX_ROOMS) {
        return refuse(callback, 'server_full', 'Server is full. Try again later.');
      }
      // ...and refuse to let ONE address take an unbounded share of that cap.
      // The one-room-per-device rule above cannot do this: deviceId is chosen
      // by the client. See MAX_ROOMS_PER_ADDRESS in rooms.ts for the hold that
      // makes the difference matter.
      const clientAddress = getClientAddress(socket);
      if (isAtRoomAddressCap(clientAddress)) {
        return refuse(callback, 'too_many_rooms', 'Too many rooms are already open from your connection. Close one before creating another.');
      }
      rooms[roomId] = createRoom(socket.id, clientAddress);

      if (initialConfig && typeof initialConfig === 'object') {
        applyValidatedConfig(rooms[roomId].state, initialConfig);
      }
    }

    const room = rooms[roomId];

    // Seat identity in this room is the SOCKET, not the device — a separate
    // rule from the one-room-per-device check above (which excludes this room)
    // and from the deviceId lookup below. Without it, one socket emitting
    // joinRoom twice for the same room under two deviceIds takes two seats:
    // handlePlayerLeave and kickPlayer both find a seat by socketId with
    // findIndex, so they only ever free the first, leaving a seat that is
    // marked connected forever — the room can then never empty out (and so
    // never be deleted), and promoteHostAfterLoss can hand it to that dead
    // socket. The seat belonging to THIS deviceId is excluded: replacing its
    // socketId is exactly the reconnect/rejoin path below.
    const seatHeldByThisSocket = room.state.players.find(
      p => p.socketId === socket.id && p.deviceId !== deviceId
    );
    if (seatHeldByThisSocket) {
      return refuse(callback, 'already_seated', 'This connection already has a seat in this room.');
    }

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
          return refuse(callback, 'name_taken', 'Username already exists in this room');
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
        io.sockets.sockets.get(existingPlayer.socketId)?.leave(roomChannel(roomId));
      }
      if (room.host === existingPlayer.socketId) room.host = socket.id;
      existingPlayer.socketId = socket.id;
      existingPlayer.disconnected = false;

      if (room.disconnectTimers[deviceId]) {
        clearTimeout(room.disconnectTimers[deviceId]);
        delete room.disconnectTimers[deviceId];
      }

      socket.join(roomChannel(roomId));
      session.roomId = roomId;
      session.username = name;
      callback({ success: true, isHost: room.host === socket.id, socketId: socket.id, name });
      emitRoomState(io, roomId);
      return;
    }

    if (room.state.status !== 'lobby') {
      return refuse(callback, 'game_running', 'Game is already running. You cannot join mid-game.');
    }

    if (room.state.players.length >= MAX_PLAYERS_PER_ROOM) {
      return refuse(callback, 'room_full', 'Room is full');
    }

    const nameConflict = room.state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (nameConflict) {
      // The conflicting player is still holding the name so they can reconnect —
      // let the host know in case they'd rather kick the ghost and free it up.
      if (nameConflict.disconnected) {
        io.to(room.host).emit('nameConflictWithDisconnected', nameConflict.name);
      }
      return refuse(callback, 'name_taken', 'Username already exists in this room');
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
    socket.join(roomChannel(roomId));

    callback({ success: true, isHost: room.host === socket.id, socketId: socket.id, name });
    emitRoomState(io, roomId);
  });

  safeOn(socket, 'leaveRoom', () => {
    if (session.roomId) socket.leave(roomChannel(session.roomId));
    handlePlayerLeave(true);
    session.roomId = null;
    session.username = null;
  });

  safeOn(socket, 'disconnect', () => {
    handlePlayerLeave(false);
  });
};
