import { getDeviceStats, updateDeviceStats, updateGlobalStats } from './database';
import { sanitizeStats, type SanitizedStats } from './sanitize';
import { rooms, emitRoomState } from './rooms';
import { statsModeFor } from './roomTypes';
import { createSocketEventLimiter } from './rateLimit';
import { safeOn, type SocketContext } from './socketContext';
import { normalizeRoomId } from '../src/utils/configValidation';
import type { EndGameStatsAck, StatsRefusalReason } from '../src/types';

/**
 * The optional callback a client may pass as endGameStats' second argument.
 *
 * Optional in the type as well as on the wire, exactly like pushState's (see
 * socketGameStateHandlers.ts): a client predating the ack sends only the
 * payload, socket.io then invokes the handler with one argument, and every
 * branch below behaves as it did before.
 */
type EndGameStatsAckFn = (result: EndGameStatsAck) => void;

const SUBMIT_GLOBAL_STATS_LIMIT = { windowMs: 10_000, max: 5 };
// Exported so the ack tests can spend exactly the budget rather than guessing
// at it — a client that hits 'rate-limited' backs off, so the number matters
// to more than this file now.
export const END_GAME_STATS_LIMIT = { windowMs: 10_000, max: 5 };

// One finish, one game — see the `gamesPlayed` override in endGameStats.
const GAMES_PER_FINISH = 1;

// Spelled out: what a merge adds to a running sum the server's verdict-only
// row has already counted.
const ALREADY_COUNTED_BY_VERDICT_ROW = 0;

/**
 * Turns a full submission into a top-up of the server's verdict-only row.
 *
 * `gamesPlayed` and `totalPlayersSum` are running sums (see deviceCols in
 * database.ts) that the verdict row already added, so the merge adds nothing
 * to either. `wins` is deleted rather than zeroed: it is additive too, but
 * its mere PRESENCE is what makes updateDeviceStats re-run the win-streak
 * CASE, and a second run over the same game would reset the streak the
 * verdict row just set. Everything else in the payload — the per-turn
 * counters, and the MIN/MAX record columns, which are idempotent by
 * construction — is exactly what the merge exists to add.
 */
const applyMergeOverrides = (clean: SanitizedStats): void => {
  clean.gamesPlayed = ALREADY_COUNTED_BY_VERDICT_ROW;
  clean.totalPlayersSum = ALREADY_COUNTED_BY_VERDICT_ROW;
  delete clean.wins;
};

/**
 * Recording what a finished game did, per device and server-wide.
 *
 * This handler only ever hears from a currently seated socket — a seat that
 * leaves, is kicked, or times out before the finish is broadcast never runs
 * this path at all. That seat's game is not lost, though: the server records
 * it itself, as a played, lost game (gamesPlayed+1, wins 0, no records — see
 * recordDepartedSeatsStats in rooms.ts), the moment the verdict is frozen.
 */
export const registerStatsHandlers = ({ io, socket, session }: SocketContext): void => {
  const submitGlobalStatsLimiter = createSocketEventLimiter(SUBMIT_GLOBAL_STATS_LIMIT);
  const endGameStatsLimiter = createSocketEventLimiter(END_GAME_STATS_LIMIT);

  safeOn(socket, 'submitGlobalStats', async (data: { roomId?: string; payload?: unknown } | null | undefined) => {
    if (!submitGlobalStatsLimiter()) return;
    if (!data || typeof data !== 'object') return;
    const { roomId: rawRoomId, payload } = data;
    if (typeof rawRoomId !== 'string') return;
    // Same canonical form joinRoom stores the room under (case and whitespace).
    const roomId = normalizeRoomId(rawRoomId);
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
    // game — and so, to a lesser degree, can the active player, who may raise
    // their OWN score to the winning one and then finish legitimately
    // (applyPushedState's `finished` branch checks a real game-over, not who
    // earned it). What this refuses is the out-of-context and replayed cases.
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
    // isDefaultGame decides whether this game's numbers join the global
    // totals at all, so it is the server's call, not the sender's: taken
    // from the config the game started with (frozen in pushState) and
    // written over whatever the payload claimed. The ruleset picks which
    // global row the numbers land in — frozen at kickoff the same way.
    // gamesPlayed is likewise the server's call, not the sender's, and for the
    // same reason endGameStats overrides it on the device row: reaching this
    // point already means room.state.finished — exactly one game — so an
    // empty or invalid payload must not leave it at the sanitized 0. Without
    // this, an empty submission advanced the global row's defaultGamesPlayed
    // counter (from isDefaultGame) while totalGamesPlayed stayed put.
    const globalStats: SanitizedStats = {
      ...sanitizeStats(payload),
      isDefaultGame: room.normalizedGame,
      gamesPlayed: GAMES_PER_FINISH,
    };
    // And so is how many people played it, for exactly the reason endGameStats
    // overrides the same pair on the device rows: the host's snapshot is its
    // own roster, which is missing anyone who left before the finish. Taking
    // one from the frozen verdict and the other from the sender left the two
    // halves of the same game disagreeing about its size.
    if (room.finishedGame) {
      globalStats.totalPlayersSum = room.finishedGame.playerCount;
      globalStats.mostPlayersInGame = room.finishedGame.playerCount;
    }
    try {
      await updateGlobalStats(globalStats, room.ruleset);
    } catch (err) {
      room.statsRecordedForGame.global = false;
      console.error('submitGlobalStats error:', err);
    }
  });

  safeOn(socket, 'endGameStats', async (
    data: { deviceId?: string; stats?: unknown } | null | undefined,
    ack?: EndGameStatsAckFn,
  ) => {
    // Every bail-out below now names itself to the sender; the gates
    // themselves are unchanged. Only 'write-failed' invites a resend — see
    // STATS_REFUSAL_REASONS in src/types.ts for what each one means to the
    // client.
    const answer = (result: EndGameStatsAck): void => {
      if (typeof ack === 'function') ack(result);
    };
    const refuse = (reason: StatsRefusalReason): void => answer({ ok: false, reason });

    if (!endGameStatsLimiter()) return refuse('rate-limited');
    if (!data || typeof data !== 'object') return refuse('invalid');
    const { deviceId, stats } = data;
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
    // See submitGlobalStats above — stats are only accepted for a game that
    // actually reached its end.
    if (!room.state.finished) return refuse('not-finished');
    // See submitGlobalStats above — same reconnect-after-finish dedup, per
    // device. A row the SERVER wrote for this device (a seat that had left or
    // was disconnected when the finish was broadcast — see
    // recordDepartedSeatsStats in rooms.ts) is only the verdict: the game and
    // its outcome, with none of this seat's per-turn counters or records,
    // which live in the very client now submitting them. Refusing that
    // submission as a duplicate lost them for good, so it is accepted as a
    // MERGE instead. Only a full row already in makes a submission a no-op.
    const recordedLevel = room.statsRecordedForGame.devices.get(deviceId);
    if (recordedLevel === 'full') return refuse('duplicate');
    const isMerge = recordedLevel === 'verdict-only';
    // See submitGlobalStats: pre-marking blocks concurrent duplicates,
    // rollback on failure keeps a retry possible instead of losing the game's
    // stats.
    room.statsRecordedForGame.devices.set(deviceId, 'full');
    // Recorded in full either way — a custom game just lands in its own
    // bucket, where it cannot move the totals or the records a player reads
    // as theirs. Which bucket is the server's call, taken from the config
    // the game started with: the frozen ruleset picks the pair, the frozen
    // normalizedGame flag picks within it.
    const mode = statsModeFor(room);
    const clean = sanitizeStats(stats);

    // Whether this device WON is the server's call, for the same reason
    // isDefaultGame is: the client computes it with getLeaders() over its own
    // roster, and that roster is wrong for anyone whose first sight of the
    // finish arrives after a seat has left — the last player standing then
    // looks like the leader and submits a win it never earned. The room froze
    // the real verdict while the winner was still seated (see
    // rememberFinishedGame). Permanent damage if it gets through:
    // fastestWinTurns is MIN-merged and the streak only ever rises.
    //
    // Only the verdict-derived fields are overridden. Everything else in the
    // payload is this seat's own accumulated counters, which no roster change
    // can falsify — the correction is not a reason to drop them.
    const finishedGame = room.finishedGame;
    if (finishedGame) {
      const won = finishedGame.winners.includes(player.name);
      const turns = typeof clean.totalTurns === 'number' ? clean.totalTurns : 0;
      clean.wins = won ? 1 : 0;
      // How many games this row records is the server's call for the same
      // reason `wins` is, and it must be decided in the same place: an empty
      // or wholly invalid payload sanitizes to {}, so the override above used
      // to write a win — and a win streak — for a game whose gamesPlayed
      // stayed 0. A finish is exactly one game, whatever the payload claims,
      // which is also the honest minimum the server's own departed-seat row
      // records (gamesPlayed 1 + the verdict's wins).
      clean.gamesPlayed = GAMES_PER_FINISH;
      // null, not 0, when there is no record to set: sanitize.ts now DROPS a
      // non-positive value for these two rather than clamping it up to 1, but
      // writing null here still states "no record" rather than leaning on
      // that drop happening downstream. A game can end before a seat's turn
      // came round, hence the turns check on BOTH sides.
      clean.fastestWinTurns = won && turns > 0 ? turns : null;
      clean.fastestLossTurns = !won && turns > 0 ? turns : null;
      clean.totalPlayersSum = finishedGame.playerCount;
      clean.mostPlayersInGame = finishedGame.playerCount;
    }

    // A merge tops up a row the server already wrote from the same verdict,
    // so everything that row counted must not be counted again. Applied
    // AFTER the override block above, which is where those very fields were
    // just set from the verdict.
    if (isMerge) applyMergeOverrides(clean);

    // Scoped to the write alone: it is the only step whose failure means
    // nothing was committed, and so the only one the dedup may be reopened
    // for. The refresh below has its own catch for exactly that reason.
    try {
      await updateDeviceStats(deviceId, clean, mode);
    } catch (err) {
      // Back to what was recorded BEFORE this attempt, not to "nothing
      // recorded": a merge whose write failed still leaves the server's
      // verdict row committed, and reopening the dedup outright would let the
      // retry count the same game a second time.
      if (recordedLevel) room.statsRecordedForGame.devices.set(deviceId, recordedLevel);
      else room.statsRecordedForGame.devices.delete(deviceId);
      console.error('[endGameStats] error:', err);
      // The rollback above is what makes this reason retryable: the client
      // resends the identical payload (see the bounded retry in
      // src/store/socketSlice.ts) and it is recorded as if the first attempt
      // had never happened.
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
        // Re-resolved AFTER the two awaits: a players-carrying push landing
        // in between (e.g. the host's Play Again) rebuilds every roster entry
        // via mergeMutable, so the pre-await `player` may be a detached
        // object — writing there would broadcast the stale streak this
        // refresh exists to fix.
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
