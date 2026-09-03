import { MAX_CHAIN_CARDS } from '../src/types';
import {
  MAX_SCORE_MAGNITUDE, MAX_ROUNDS, MAX_GAME_SECONDS, MAX_PLAYERS_PER_ROOM,
} from '../src/utils/configValidation';

export const STATS_VALUE_CAP = 1e9;

// Indent prepended to continuation lines of multi-line log fields — see
// indentLogContinuationLines.
const LOG_CONTINUATION_INDENT = '    ';

// ANSI CSI sequences. Not just colour: CUU/EL (ESC[1A ESC[2K) move the cursor
// onto log lines ALREADY written and blank them, so a crafted field can erase
// or overwrite genuine entries in a live terminal without ever emitting a
// newline of its own — which is all the CR/LF handling below can stop.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// The remaining control characters a log reader acts on rather than prints: a
// NUL truncates the line in several log processors, and BEL, backspace and a
// bare ESC survive the CSI pattern above. CR (\x0d) and LF (\x0a) are excluded
// — each function below has its own rule for them — and so is tab (\x09),
// which cannot forge an entry and whose removal would mangle legitimately
// tab-separated messages.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const LOG_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const stripLogControlChars = (value: string): string =>
  value.replace(ANSI_ESCAPE, '').replace(LOG_CONTROL_CHARS, '');

// Everything a log reader may break a line on. CR/LF are the obvious pair;
// U+0085 (NEL) sits just past the \x7f where LOG_CONTROL_CHARS above stops,
// and U+2028/U+2029 are far beyond it — all three survive that sweep, and any
// viewer or editor treating them as terminators shows a crafted field as its
// own top-level entry, which is exactly what the two functions below exist to
// prevent.
const LINE_BREAK_CHARS = '\\r\\n\\u2028\\u2029\\u0085';
const ANY_LINE_BREAK_RUN = new RegExp(`[${LINE_BREAK_CHARS}]+`, 'g');
// CRLF first so the pair collapses into one indent rather than two.
const ANY_LINE_BREAK = new RegExp(`\\r\\n|[${LINE_BREAK_CHARS}]`, 'g');

// For client-supplied values interpolated into a log entry's HEADER line
// (e.g. the crash report's timestamp/message): an embedded line break would
// let a crafted value forge entirely fake log entries.
export const sanitizeLogHeaderField = (value: string): string =>
  stripLogControlChars(value).replace(ANY_LINE_BREAK_RUN, ' ');

// For legitimately multi-line log fields (stack traces): keeps the newlines
// but indents every continuation line, so no embedded line can masquerade as
// a fresh top-level log entry (e.g. a forged "[client-error] ..." line). Just
// as client-supplied as the header fields and bound for the same log, so it
// gets the same escape stripping — indenting a line does nothing about an
// ANSI sequence inside it.
export const indentLogContinuationLines = (value: string): string =>
  stripLogControlChars(value).replace(ANY_LINE_BREAK, `\n${LOG_CONTINUATION_INDENT}`);

// A turn count of 0 is meaningless for these two fields (a game always takes
// at least 1 turn) — named here as the single source of truth for which
// fields are DROPPED below 1 rather than clamped up to the default floor of 0.
//
// Dropped, not clamped: both are MIN-merged record columns whose best
// possible value IS 1, so clamping a 0 (or a negative, or a fraction that
// floors to 0) up to it wrote an unbeatable record out of a value that says
// nothing — and nothing short of editing the database dislodges it again.
// Absent is what such a value means, and an absent record column is left
// alone by both merge paths.
//
// They get no UPPER bound, which is why they are not in RECORD_STATS_BOUNDS
// below: a huge value never poisons a MIN column — it just loses the merge —
// so dropping one would buy nothing, and raising it toward MIN_RECORD_TURNS
// would write the very unbeatable record this drop exists to prevent.
const MIN_RECORD_STATS_FIELDS = new Set(['fastestWinTurns', 'fastestLossTurns']);

// The smallest turn count either of those records can honestly hold.
const MIN_RECORD_TURNS = 1;

// Modernized rules keep Plus/Minus deductions unclamped (see the engine's
// deliberate no-clamp comment), so a player can legitimately FINISH a game
// below zero — flooring their totalScore at 0 silently inflated every sum
// and average built on it. Counters and records stay non-negative.
const NEGATIVE_ALLOWED_STATS_FIELDS = new Set(['totalScore']);

// The only field on GlobalStatsPayload that is legitimately a boolean; every
// other one is a number or null. A boolean anywhere else used to be waved
// through UNCLAMPED, because that branch ran before the floors below —
// node-sqlite3 then binds false as integer 0 and RECORD_COLUMNS merges it with
// MIN, so `fastestWinTurns: false` pinned the best-ever turn count at 0 with no
// path back short of editing the database. Dropped rather than coerced to 0/1,
// on the same reasoning as the array case below: no legitimate client sends a
// boolean for a counter, so one arriving is a malformed payload.
const BOOLEAN_STATS_FIELDS = new Set(['isDefaultGame']);

/**
 * The MAX-merged record columns, and the largest value each can honestly hold.
 *
 * STATS_VALUE_CAP on its own left a hole between two layers that both look
 * careful: pushValidation refuses a turn score past MAX_SCORE_MAGNITUDE, but
 * nothing tied the STATS payload to the state it claims to describe — so a
 * host could play a real game to a legitimate finish and then submit
 * `highestTurnScore: 1e9`, which sailed through and, because RECORD_COLUMNS
 * merges these with MAX in database.ts, pinned the record for good.
 *
 * Every bound here is the one the value's own source already enforces, so no
 * real game can reach it: a turn score by MAX_SCORE_MAGNITUDE, a round number
 * by MAX_ROUNDS, a roster by MAX_PLAYERS_PER_ROOM, one turn's chain by
 * MAX_CHAIN_CARDS. Taken from those constants rather than restated, so a
 * loosened bound upstream cannot leave a stale ceiling here.
 *
 * The two MIN-merged records are deliberately absent — see
 * MIN_RECORD_STATS_FIELDS above for why bounding those is either inert or the
 * very bug that comment warns about.
 *
 * Exported so sanitize.test.ts generates its cases from this list, the way
 * database.test.ts generates its record-column cases from RECORD_COLUMNS: a
 * column added here arrives already covered.
 */
export const RECORD_STATS_BOUNDS: ReadonlyMap<string, number> = new Map([
  ['highestTurnScore', MAX_SCORE_MAGNITUDE],
  ['highestFeuerwerkTurnScore', MAX_SCORE_MAGNITUDE],
  ['highestX2TurnScore', MAX_SCORE_MAGNITUDE],
  ['highestForfeitedTurnScore', MAX_SCORE_MAGNITUDE],
  ['mostPlayersInGame', MAX_PLAYERS_PER_ROOM],
  ['longestGameRounds', MAX_ROUNDS],
  ['mostCardsInTurn', MAX_CHAIN_CARDS],
]);

/**
 * The most one player can add to an additive counter over a single game.
 *
 * Those counters come in three families with different natural ceilings — a
 * duration (totalPlaytime, bounded by MAX_GAME_SECONDS), a score (totalScore,
 * MAX_SCORE_MAGNITUDE) and a count (totalTurns and the per-turn tallies, none
 * of which can outrun MAX_ROUNDS) — and one shared bound has to clear the
 * largest of them or it would silently truncate a legitimate submission.
 * Derived from all three rather than picked, so raising any one of them
 * carries through without anyone having to remember this line.
 */
export const MAX_ADDITIVE_PER_PLAYER = Math.max(MAX_GAME_SECONDS, MAX_SCORE_MAGNITUDE, MAX_ROUNDS);

/**
 * The same counters on a global row are a sum over every seat that played, so
 * an identical key legitimately holds up to MAX_PLAYERS_PER_ROOM times as
 * much there. One shared cap across both shapes is either useless on a device
 * row or lossy on a global one, which is why sanitizeStats has to be told
 * which it is sanitizing for.
 */
export const MAX_ADDITIVE_PER_GLOBAL_ROW = MAX_ADDITIVE_PER_PLAYER * MAX_PLAYERS_PER_ROOM;

// The two additive counters left at the general STATS_VALUE_CAP instead of the
// per-game bound above. The token-gated admin route (POST /api/stats/:deviceId)
// legitimately corrects a miscount in one multi-game call rather than one game
// at a time, and api.routes.test.ts + api.test.ts pin that. Safe to exempt
// precisely because both are plain running sums: nothing they carry is
// permanent, so the same route can subtract it again — unlike a record column,
// where a single write is forever.
const MULTI_GAME_ADDITIVE_STATS_FIELDS = new Set(['gamesPlayed', 'wins']);

export type SanitizedStats = Record<string, number | boolean | null>;

// Which row shape the payload is bound for. Deliberately required rather than
// defaulted: a call site that forgot it would either truncate a legitimate
// whole-room sum or hand a device row a hundred times the bound it needs, and
// neither failure says anything at the time it happens.
export type StatsScope = 'device' | 'global';

export const sanitizeStats = (raw: unknown, scope: StatsScope): SanitizedStats => {
  if (!raw || typeof raw !== 'object') return {};
  const additiveCap = scope === 'global' ? MAX_ADDITIVE_PER_GLOBAL_ROW : MAX_ADDITIVE_PER_PLAYER;
  const clean: SanitizedStats = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'boolean') {
      if (BOOLEAN_STATS_FIELDS.has(key)) clean[key] = val;
      continue;
    }
    // Kept for every key: null is the record columns' "no record yet", and
    // nullSafeExtreme is built to leave the stored value alone when it sees one.
    if (val === null) {
      clean[key] = val;
      continue;
    }
    // Restricted to number/string before coercing — numeric strings ('3') are
    // legitimately accepted, but Number(val) on anything else can still
    // "succeed" via a type's own toString (e.g. Number([42]) === 42, via
    // Array.prototype.toString), letting a single-element array pass through
    // as a valid stat.
    if (typeof val !== 'number' && typeof val !== 'string') continue;
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    const capped = Math.min(Math.floor(n), STATS_VALUE_CAP);
    if (MIN_RECORD_STATS_FIELDS.has(key)) {
      if (capped < MIN_RECORD_TURNS) continue;
      clean[key] = capped;
      continue;
    }
    const recordBound = RECORD_STATS_BOUNDS.get(key);
    if (recordBound !== undefined) {
      // Dropped, not clamped, for exactly the reason a non-positive
      // fastestWinTurns is: these columns are MAX-merged, so a clamp still
      // WRITES a permanent value — the sender simply pins the record at the
      // clamp instead of at STATS_VALUE_CAP, and nothing short of editing the
      // database takes it back down. Writing nothing leaves the stored record
      // where the last honest game left it, which is what an out-of-range
      // value actually means.
      if (capped > recordBound) continue;
      clean[key] = Math.max(0, capped);
      continue;
    }
    // Additive counters are safe to CLAMP rather than drop: they are running
    // sums, so nothing a clamp writes is permanent — the token-gated route can
    // subtract it again — while dropping one would silently lose the honest
    // part of a real game's submission.
    const maxAllowed = MULTI_GAME_ADDITIVE_STATS_FIELDS.has(key) ? STATS_VALUE_CAP : additiveCap;
    // totalScore's negative bound deliberately stays the wider
    // STATS_VALUE_CAP: it is the only field not floored at 0, which makes it
    // the only way an operator can subtract a poisoned total back out. Bounding
    // that direction would take the repair away along with the abuse.
    const minAllowed = NEGATIVE_ALLOWED_STATS_FIELDS.has(key) ? -STATS_VALUE_CAP : 0;
    clean[key] = Math.max(minAllowed, Math.min(maxAllowed, capped));
  }
  return clean;
};
