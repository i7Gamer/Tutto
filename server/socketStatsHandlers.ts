import { getDeviceStats, updateDeviceStats, updateGlobalStats } from './database';
import { sanitizeStats } from './sanitize';
import { rooms, emitRoomState } from './rooms';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';

const SUBMIT_GLOBAL_STATS_LIMIT = { windowMs: 10_000, max: 5 };
const END_GAME_STATS_LIMIT = { windowMs: 10_000, max: 5 };

/** Recording what a finished game did, per device and server-wide. */
export const registerStatsHandlers = ({ io, socket, session }: SocketContext): void => {
  const submitGlobalStatsLimiter = createSocketEventLimiter(SUBMIT_GLOBAL_STATS_LIMIT);
  const endGameStatsLimiter = createSocketEventLimiter(END_GAME_STATS_LIMIT);

  safeOn(socket, 'submitGlobalStats', async (data: { roomId?: string; payload?: unknown } | null | undefined) => {
    if (!submitGlobalStatsLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId, payload } = data;
    if (typeof roomId !== 'string') return;
    // Only the room host may submit global stats, authenticated by socket identity.
    // No token needed — the WebSocket session is the credential.
    const room = rooms[roomId];
    if (!room || room.host !== socket.id) return;
    // Stats only exist for a game that actually reached its end — without
    // this gate, a host could submit fabricated stats straight from the
    // lobby, and repeat at will by re-triggering pushState's startingGame
    // dedup reset between submissions. Ordering with the winner's own
    // submission is safe: the finishing client emits pushState (carrying
    // finished=true) BEFORE its stats (see gameSlice.nextTurn), and
    // socket.io preserves per-connection event order. The host-authoritative
    // state model means a determined host can still stage a fake finished
    // game; this refuses the out-of-context and replayed cases.
    if (!room.state.finished) return;
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
      // isDefaultGame decides whether this game's numbers join the global
      // totals at all, so it is the server's call, not the sender's: taken
      // from the config the game started with (frozen in pushState) and
      // written over whatever the payload claimed. The ruleset picks which
      // global row the numbers land in — frozen at kickoff the same way.
      await updateGlobalStats({ ...sanitizeStats(payload), isDefaultGame: room.normalizedGame }, room.ruleset);
    } catch (err) {
      room.statsRecordedForGame.global = false;
      console.error('submitGlobalStats error:', err);
    }
  });

  safeOn(socket, 'endGameStats', async (data: { deviceId?: string; stats?: unknown } | null | undefined) => {
    if (!endGameStatsLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { deviceId, stats } = data;
    if (typeof deviceId !== 'string') return;
    // A socket may only submit stats for its OWN device, and only while it is a
    // member of its current room. This mirrors the token gate on the HTTP path
    // (POST /api/stats/:deviceId) so the socket route can't be used to write
    // arbitrary device statistics.
    const roomId = session.roomId;
    const room = roomId ? rooms[roomId] : null;
    const player = room?.state.players.find(p => p.socketId === socket.id);
    if (!player || player.deviceId !== deviceId || !room) return;
    // See submitGlobalStats above — stats are only accepted for a game that
    // actually reached its end.
    if (!room.state.finished) return;
    // See submitGlobalStats above — same reconnect-after-finish dedup, per device.
    if (room.statsRecordedForGame.devices.has(deviceId)) return;
    // See submitGlobalStats: pre-add blocks concurrent duplicates, rollback
    // on failure keeps a retry possible instead of losing the game's stats.
    room.statsRecordedForGame.devices.add(deviceId);
    try {
      // Recorded in full either way — a custom game just lands in its own
      // bucket, where it cannot move the totals or the records a player reads
      // as theirs. Which bucket is the server's call, taken from the config
      // the game started with: the frozen ruleset picks the pair, the frozen
      // normalizedGame flag picks within it.
      const mode = room.ruleset === 'classic'
        ? (room.normalizedGame ? 'classic' : 'classic_custom')
        : (room.normalizedGame ? 'normalized' : 'custom');
      await updateDeviceStats(deviceId, sanitizeStats(stats), mode);
      // The win/loss just recorded above may have changed this device's streak.
      // `player` still holds the value from when they joined, so without this
      // refresh + broadcast, the streak shown next to the player (leaderboard,
      // spectators) stays stale until they rejoin a room.
      //
      // Only for the two non-custom buckets: each has its own streak field
      // (the badge shows whichever matches the room's ruleset), and a custom
      // game neither extends nor breaks either. Refreshing here would
      // overwrite the displayed streak with the custom bucket's count.
      if (mode === 'normalized' || mode === 'classic') {
        const updatedStats = await getDeviceStats(deviceId, mode);
        if (mode === 'classic') {
          player.winStreakClassic = updatedStats?.currentWinStreak ?? 0;
        } else {
          player.winStreak = updatedStats?.currentWinStreak ?? 0;
        }
        emitRoomState(io, roomId as string);
      }
    } catch (err) {
      room.statsRecordedForGame.devices.delete(deviceId);
      console.error('[endGameStats] error:', err);
    }
  });
};
