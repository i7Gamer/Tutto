import { getDeviceStats, updateDeviceStats, updateGlobalStats } from './database';
import { rooms, emitRoomState } from './rooms';
import { statsModeFor } from './roomTypes';
import { pendingDeviceStatsWrite, writeDeviceStatsOnce } from './statsWriteCoordinator';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';
import type { StatsSubmitAck, StatsRefusalReason } from '../src/types';
import { buildDeviceStatsPayload, buildGlobalStatsPayload } from '../src/utils/statsPayloads';

/**
 * The optional callback a client may pass as the second argument to either
 * stats submission — endGameStats or submitGlobalStats.
 *
 * Optional in the type as well as on the wire, exactly like pushState's (see
 * socketGameStateHandlers.ts): a client predating the ack sends only the
 * payload, socket.io then invokes the handler with one argument, and every
 * branch below behaves as it did before.
 */
type StatsSubmitAckFn = (result: StatsSubmitAck) => void;

/**
 * The answer/refuse pair a submission handler names its outcome with.
 *
 * Shared by both handlers so the two cannot drift into answering the same
 * situation differently — and so neither has to re-state that a missing
 * callback is simply not called.
 */
const ackHelpers = (ack: StatsSubmitAckFn | undefined) => {
  const answer = (result: StatsSubmitAck): void => {
    if (typeof ack === 'function') ack(result);
  };
  return { answer, refuse: (reason: StatsRefusalReason): void => answer({ ok: false, reason }) };
};

// Exported for the same reason END_GAME_STATS_LIMIT is: the ack tests spend
// exactly the budget rather than guessing at it.
export const SUBMIT_GLOBAL_STATS_LIMIT = { windowMs: 10_000, max: 5 };
// Exported so the ack tests can spend exactly the budget rather than guessing
// at it — a client that hits 'rate-limited' backs off, so the number matters
// to more than this file now.
export const END_GAME_STATS_LIMIT = { windowMs: 10_000, max: 5 };

/**
 * Recording what a finished game did, per device and server-wide.
 *
 * This handler only ever hears from a currently seated socket. The completed
 * row is nevertheless built from server-captured participant state; a departed
 * seat receives that same complete row when the verdict is frozen.
 */
export const registerStatsHandlers = ({ io, socket, session }: SocketContext): void => {
  const submitGlobalStatsLimiter = createSocketEventLimiter(SUBMIT_GLOBAL_STATS_LIMIT);
  const endGameStatsLimiter = createSocketEventLimiter(END_GAME_STATS_LIMIT);

  safeOn(socket, 'submitGlobalStats', async (
    data: { roomId?: string; payload?: unknown; finishedGameToken?: string } | null | undefined,
    ack?: StatsSubmitAckFn,
  ) => {
    // Every bail-out below names itself to the sender; the gates themselves
    // are unchanged. Only 'write-failed' invites a resend — see
    // STATS_REFUSAL_REASONS in src/types.ts for what each one means to the
    // client, and endGameStats below for the same treatment of the device row.
    const { answer, refuse } = ackHelpers(ack);

    if (!submitGlobalStatsLimiter()) return refuse('rate-limited');
    if (!data || typeof data !== 'object') return refuse('invalid');
    // Resolved from the session — the room this socket is actually seated
    // in — the same source endGameStats uses, rather than the roomId in the
    // wire payload above (kept there for older clients, but no longer
    // trusted): the host check below alone doesn't stop a stale or forged
    // payload roomId from naming some OTHER room this same socket also
    // happens to host (e.g. having left one room and hosted another earlier
    // in its connection's lifetime).
    const roomId = session.roomId;
    // Only the room host may submit global stats, authenticated by socket identity.
    // No token needed — the WebSocket session is the credential.
    const room = roomId ? rooms[roomId] : null;
    if (!room) return refuse('no-room');
    if (room.host !== socket.id) return refuse('unauthorized');
    // A finish can be followed by Play Again while a stats retry is in flight.
    // Match the frozen finish, not the latest room mutation or the current
    // finished flag: the next game may already have finished too. Omission
    // preserves older clients; a present malformed or stale token never writes.
    if ('finishedGameToken' in data &&
        (typeof data.finishedGameToken !== 'string' || data.finishedGameToken !== room.finishedGameToken)) {
      return refuse('invalid');
    }
    // A stats request can record only a game the server has finished through
    // an accepted action, a turn timeout, or an active-player removal. Clients
    // submit actions through pushState; they cannot set the finished flag or
    // the counters persisted below with a pushed snapshot or stats payload.
    if (!room.state.finished) return refuse('not-finished');
    const finishedGame = room.finishedGame;
    if (!finishedGame) return refuse('invalid');
    // A reconnect/reload after the game already finished (but before anyone
    // leaves the room) makes the client think "finished just became true" again,
    // re-submitting for the same game. Recorded per game, reset when a new one
    // starts (see pushState's accepted-start branch).
    //
    // Captured once, here, rather than read again after the await below:
    // An accepted start replaces room.statsRecordedForGame (a new object)
    // when the next game starts, which can land while updateGlobalStats is
    // still in flight for THIS one. Rolling back through `room.statsRecordedForGame`
    // at that point would write into the NEXT game's dedup instead of this
    // one's — see the `dedup === room.statsRecordedForGame` check in the catch.
    const dedup = room.statsRecordedForGame;
    if (dedup.global) return refuse('duplicate');
    // Marked BEFORE the await so a concurrent duplicate can't slip through,
    // but rolled back on failure — otherwise a transient DB error would
    // permanently swallow this game's stats (the dedup would reject a retry).
    dedup.global = true;
    // The accepted start captures the statistics configuration: normalizedGame
    // decides whether counters join the global totals, and ruleset selects the
    // row. The server derives every counter and records exactly one game,
    // regardless of whether the request includes a stats payload.
    const globalStats = {
      ...buildGlobalStatsPayload(
        finishedGame.players,
        finishedGame.gameTimeInSeconds,
        room.normalizedGame,
        finishedGame.round,
        finishedGame.winnerDeviceIds,
      ),
      totalPlayersSum: finishedGame.playerCount,
      mostPlayersInGame: finishedGame.playerCount,
      totalRoundsSum: finishedGame.round,
      longestGameRounds: finishedGame.round,
    };
    try {
      await updateGlobalStats(globalStats, room.ruleset);
    } catch (err) {
      // Only if `dedup` is still the room's CURRENT dedup object — a Play
      // Again landing during the await above already gave the room a fresh
      // one (see the capture above), and this game's rollback must not
      // reach into that unrelated, already-in-progress next game.
      if (room.statsRecordedForGame === dedup) dedup.global = false;
      console.error('submitGlobalStats error:', err);
      // The rollback above is what makes this reason retryable: the client
      // resends the identical payload (see the bounded retry in
      // src/store/socketSlice.ts) and it is recorded as if this attempt had
      // never happened.
      return refuse('write-failed');
    }
    // Committed — the only path that acks a success.
    answer({ ok: true });
  });

  safeOn(socket, 'endGameStats', async (
    data: { deviceId?: string; stats?: unknown; finishedGameToken?: string } | null | undefined,
    ack?: StatsSubmitAckFn,
  ) => {
    // Every bail-out below now names itself to the sender; the gates
    // themselves are unchanged. Only 'write-failed' invites a resend — see
    // STATS_REFUSAL_REASONS in src/types.ts for what each one means to the
    // client.
    const { answer, refuse } = ackHelpers(ack);

    if (!endGameStatsLimiter()) return refuse('rate-limited');
    if (!data || typeof data !== 'object') return refuse('invalid');
    const { deviceId } = data;
    if (typeof deviceId !== 'string') return refuse('invalid');
    // A socket may only submit stats for its OWN device, and only while it is a
    // member of its current room. This mirrors the token gate on the HTTP path
    // (POST /api/stats/:deviceId) so the socket route can't be used to write
    // arbitrary device statistics.
    const roomId = session.roomId;
    const room = roomId ? rooms[roomId] : null;
    if (!room) return refuse('no-room');
    const player = room.state.players.find(p => p.socketId === socket.id);
    if (!player || player.deviceId !== deviceId) return refuse('unauthorized');
    // Same finish identity as the global row above, checked before the dedup
    // is reserved or any database work starts. Presence broadcasts keep this
    // identity; a rematch gets a different one.
    if ('finishedGameToken' in data &&
        (typeof data.finishedGameToken !== 'string' || data.finishedGameToken !== room.finishedGameToken)) {
      return refuse('invalid');
    }
    // See submitGlobalStats above — stats are only accepted for a game that
    // actually reached its end.
    if (!room.state.finished) return refuse('not-finished');
    // Complete departed-seat rows and prior endGameStats writes are duplicates.
    // Captured once, here, rather than read again after the await below:
    // An accepted start replaces room.statsRecordedForGame with a new object
    // and Set. The coordinator reserves and publishes writes against this
    // captured game's object, so completion or failure during a rematch cannot
    // alter the next game's deduplication state.
    const dedup = room.statsRecordedForGame;
    const finishToken = room.finishedGameToken;
    // A returning seat waits for an in-flight write before deciding to retry.
    // Recheck after every wait: another submission may have reserved the
    // same device while this one was queued behind the departed writer.
    let pending = pendingDeviceStatsWrite(dedup, deviceId);
    while (pending) {
      await pending;
      if (rooms[roomId as string] !== room || room.statsRecordedForGame !== dedup ||
          room.finishedGameToken !== finishToken || !room.state.finished) return refuse('invalid');
      if (session.roomId !== roomId || !room.state.players.some(p =>
        p.deviceId === deviceId && p.socketId === socket.id)) return refuse('unauthorized');
      pending = pendingDeviceStatsWrite(dedup, deviceId);
    }
    if (dedup.devices.has(deviceId)) return refuse('duplicate');
    // The coordinator reserves pending writes separately from committed rows.
    // Recorded in full either way — a custom game just lands in its own
    // bucket, where it cannot move the totals or the records a player reads
    // as theirs. Which bucket is the server's call, taken from the config
    // the game started with: the frozen ruleset picks the pair, the frozen
    // normalizedGame flag picks within it.
    const mode = statsModeFor(room);

    // Use the frozen winner identities and participant counters so departures
    // after the finish cannot change the recorded outcome or records.
    const finishedGame = room.finishedGame;
    if (!finishedGame) return refuse('invalid');
    const serverPlayers = finishedGame.players;
    const serverPlayer = serverPlayers.find(candidate => candidate.deviceId === deviceId);
    if (!serverPlayer) return refuse('invalid');
    const clean = buildDeviceStatsPayload(
      serverPlayers,
      serverPlayer.name,
      finishedGame.gameTimeInSeconds,
      finishedGame.round,
      finishedGame.winnerDeviceIds,
    );
    if (!clean) return refuse('invalid');
    clean.totalPlayersSum = finishedGame.playerCount;
    clean.mostPlayersInGame = finishedGame.playerCount;
    clean.totalRoundsSum = finishedGame.round;
    clean.longestGameRounds = finishedGame.round;

    // Only a failed write permits a retry. The streak refresh below has its
    // own catch because its failure cannot undo a committed statistics row.
    try {
      await writeDeviceStatsOnce(dedup, deviceId, () => updateDeviceStats(deviceId, { ...clean }, mode));
    } catch (err) {
      // The coordinator releases only this captured game's reservation on
      // failure, never a rematch's.
      console.error('[endGameStats] error:', err);
      // No committed marker was published, so the client can retry this
      // finish (see the bounded retry in src/store/socketSlice.ts).
      return refuse('write-failed');
    }

    // Committed. Acked BEFORE the streak refresh below, which is a broadcast
    // concern rather than part of the submission: its failure must not read
    // as a lost write, and the client has nothing to do about it either way.
    answer({ ok: true });

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
      try {
        const updatedStats = await getDeviceStats(deviceId, mode);
        // Accepted actions can replace every roster entry during the awaits.
        // Resolve the current seat so the refresh reaches the live player,
        // including after the host starts a rematch.
        const currentSeat = rooms[roomId as string]?.state.players.find(p => p.deviceId === deviceId);
        if (currentSeat) {
          if (mode === 'classic') {
            currentSeat.winStreakClassic = updatedStats?.currentWinStreak ?? 0;
          } else {
            currentSeat.winStreak = updatedStats?.currentWinStreak ?? 0;
          }
          emitRoomState(io, roomId as string);
        }
      } catch (err) {
        // Deliberately does NOT touch the dedup: the device row above is
        // already committed, so reopening it would let a retry count this
        // game a second time. A stale streak badge is the lesser failure —
        // it corrects itself on the device's next room join.
        console.error('[endGameStats] streak refresh error:', err);
      }
    }
  });
};
