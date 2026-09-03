import { rooms, deleteRoom, handleActivePlayerRemoved, emitRoomState, promoteHostAfterLoss, roomChannel, isAbandonedRoom, UNCLAIMED_HOST } from './rooms';
import { startServerTurnTimer, abortGameIfLowPlayers } from './turnTimers';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';
import { COLOR_RE } from './playerColor';
import { normalizeRoomId } from '../src/utils/configValidation';
import type { ServerPlayer } from './roomTypes';

// Reordering is a discrete button click in the lobby — same cap as kicking.
const REORDER_PLAYERS_LIMIT = { windowMs: 1_000, max: 5 };
// The color picker fires continuously while dragging (React onChange maps to
// the native input event) — same generous cap as the other continuous-UI
// events (pushState/updateConfig).
const UPDATE_PLAYER_COLOR_LIMIT = { windowMs: 1_000, max: 20 };
const KICK_PLAYER_LIMIT = { windowMs: 1_000, max: 5 };

// Minimal shape check for a client-supplied roster entry: only `.name` is ever
// read from one (reorderPlayers matches seats by name, exactly like
// pushValidation's player merge).
const isNamedEntry = (v: unknown): v is { name: string } =>
  typeof v === 'object' && v !== null && typeof (v as { name?: unknown }).name === 'string';

/** Who is at the table, in what order, wearing which colour. */
export const registerRosterHandlers = ({ io, socket, session }: SocketContext): void => {
  const reorderPlayersLimiter = createSocketEventLimiter(REORDER_PLAYERS_LIMIT);
  const updatePlayerColorLimiter = createSocketEventLimiter(UPDATE_PLAYER_COLOR_LIMIT);
  const kickPlayerLimiter = createSocketEventLimiter(KICK_PLAYER_LIMIT);

  safeOn(socket, 'reorderPlayers', (data: { roomId?: string; newPlayers?: { name: string }[] } | null | undefined) => {
    if (!reorderPlayersLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId: rawRoomId, newPlayers } = data;
    // Same normalization joinRoom applies before ever touching `rooms`.
    if (typeof rawRoomId !== 'string') return;
    const roomId = normalizeRoomId(rawRoomId);
    if (!rooms[roomId] || rooms[roomId].host !== socket.id) return;
    if (rooms[roomId].state.status !== 'lobby') return;
    // Guard against non-array payloads, which would throw on the .map/.length below.
    if (!Array.isArray(newPlayers)) return;
    // ...and against non-object ENTRIES, which the .map below dereferences for
    // `.name`. socket.io dispatches listeners from a bare process.nextTick, so
    // a throw here is an uncaught exception with no caller to catch it — and
    // index.ts installs no uncaughtException handler, so it terminates the
    // whole process: every room, every player, triggerable by anyone who
    // holds a room's host slot (i.e. anyone who creates one).
    if (!newPlayers.every(isNamedEntry)) return;

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

  safeOn(socket, 'updatePlayerColor', (data: { roomId?: string; color?: string } | null | undefined) => {
    if (!updatePlayerColorLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId: rawRoomId, color } = data;
    if (typeof rawRoomId !== 'string' || typeof color !== 'string') return;
    // Same normalization joinRoom applies before ever touching `rooms`.
    const roomId = normalizeRoomId(rawRoomId);
    if (!rooms[roomId]) return;
    // A lobby control, like reorderPlayers above: the colour picker is the
    // only production caller (gameSlice.ts), and it is only reachable from the
    // lobby. Ungated it was a full re-broadcast of the room state from any
    // seat at the limiter's 20/s, repainting a player mid-game under a
    // historyLog whose entries already carry the colour they played under.
    if (rooms[roomId].state.status !== 'lobby') return;
    if (!COLOR_RE.test(color)) return;
    const player = rooms[roomId].state.players.find(p => p.socketId === socket.id);
    if (player) {
      player.color = color;
      emitRoomState(io, roomId);
    }
  });

  safeOn(socket, 'kickPlayer', (targetSocketId: string) => {
    if (!kickPlayerLimiter()) return;
    if (typeof targetSocketId !== 'string') return;
    const roomId = session.roomId;
    if (!roomId || !rooms[roomId] || rooms[roomId].host !== socket.id) return;
    const room = rooms[roomId];

    const removedIdx = room.state.players.findIndex(p => p.socketId === targetSocketId);
    // A stale id is routine — the host's roster is only as fresh as its last
    // broadcast, so it can name a seat that has since reconnected, left, or
    // been kicked. Nothing below applies to a kick that removed nobody, and
    // falling through ran all of it: the room-teardown check, the turn-timer
    // re-arm, and a full emitRoomState to everyone in the room.
    if (removedIdx === -1) return;

    // Only emit once the target is confirmed to be in the host's own room —
    // otherwise a host could send a 'kicked' signal to any socket on the
    // server, booting players out of unrelated rooms client-side.
    io.to(targetSocketId).emit('kicked');
    // Out of the channel in the same breath, BEFORE the room is torn down
    // around them. This used to be the last line of the handler, so the kicked
    // socket stayed subscribed through handleActivePlayerRemoved, the host
    // reassignment, abortGameIfLowPlayers and a full emitRoomState — and took
    // all of it: a spurious "game aborted" toast on top of "you were kicked",
    // plus hostId and gameState writes into what is by then LOCAL state. Only
    // 'gameState' carries a late-broadcast guard client-side, and adding one
    // per event is the wrong shape when leaving first closes the whole class.
    io.sockets.sockets.get(targetSocketId)?.leave(roomChannel(roomId));
    const removedPlayer = room.state.players[removedIdx];
    room.state.players.splice(removedIdx, 1);
    handleActivePlayerRemoved(room, removedIdx);
    // A kicked player may be mid-reconnect-countdown; leaving that timer armed
    // would later remove whoever rejoined the room on the same device.
    if (room.disconnectTimers[removedPlayer.deviceId]) {
      clearTimeout(room.disconnectTimers[removedPlayer.deviceId]);
      delete room.disconnectTimers[removedPlayer.deviceId];
    }

    // Reachable when a (modified) host client self-kicks out of a room whose
    // every other seat is a timerless ghost — see isAbandonedRoom for why such
    // a room can never be freed again. handlePlayerLeave guards the same case
    // on the explicit-leave path, and the reconnect timer on its own.
    if (room.state.players.length === 0 || isAbandonedRoom(room)) {
      deleteRoom(roomId);
    } else {
      // Only a (modified) host client can kick its own socket, but if it does,
      // the room must not keep a host id that is no longer seated — no one
      // could change config, kick, or restart until the room died. Through the
      // shared helper rather than inline, because the inline version fell back
      // to `?? room.state.players[0]` and so pinned the room on whichever
      // DISCONNECTED seat happened to sit first — worse than leaving it
      // unclaimed, which joinRoom repairs for the first player back.
      if (!promoteHostAfterLoss(room) && room.host === targetSocketId) {
        // Nobody connected to promote to, and the id still on the room is the
        // socket this kick just unseated. promoteHostAfterLoss deliberately
        // leaves an unpromotable room UNCLAIMED rather than pinning it on a
        // ghost — but "leave it alone" is the wrong outcome when the holder is
        // a live socket with no seat: it would keep updateConfig, kickPlayer
        // and submitGlobalStats over a room it is no longer in, and joinRoom's
        // repair (which only fires while the host seat is lost) could never
        // hand the room to a player who came back. Clearing it is what makes
        // the first client back the new host.
        room.host = UNCLAIMED_HOST;
      }
      const aborted = abortGameIfLowPlayers(io, room, roomId);
      // If the kicked player was mid-turn, handleActivePlayerRemoved already
      // reset turnStartTime for the player now in their slot — resync the timer.
      if (!aborted) startServerTurnTimer(io, roomId);
      emitRoomState(io, roomId);
    }
  });
};
