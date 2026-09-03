/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeStats, sanitizeLogHeaderField, indentLogContinuationLines,
  STATS_VALUE_CAP, RECORD_STATS_BOUNDS, MIN_RECORD_STATS_FIELDS,
  ADDITIVE_STATS_BOUNDS,
  type StatsScope,
} from './sanitize';
import { RECORD_COLUMNS } from './database';
import {
  MAX_PLAYERS_PER_ROOM, MAX_GAME_SECONDS, MAX_SCORE_MAGNITUDE, MAX_ROUNDS,
} from '../src/utils/configValidation';

// Most of what sanitizeStats does is the same in both scopes (the type
// guards, the floors, the record-column drops), so those cases are written
// against whichever row the field really belongs to and the two scopes are
// only played off against each other where they actually differ — the
// additive bound. Named rather than passed as bare strings so a scope reads
// as a decision at every call site instead of an argument nobody looks at.
const DEVICE: StatsScope = 'device';
const GLOBAL: StatsScope = 'global';

describe('sanitizeStats', () => {
  it('returns an empty object for non-object input', () => {
    expect(sanitizeStats(null, DEVICE)).toEqual({});
    expect(sanitizeStats(undefined, DEVICE)).toEqual({});
    expect(sanitizeStats('nope', DEVICE)).toEqual({});
    expect(sanitizeStats(42, DEVICE)).toEqual({});
  });

  it('passes through isDefaultGame, the one field that is legitimately a boolean', () => {
    expect(sanitizeStats({ isDefaultGame: true }, GLOBAL)).toEqual({ isDefaultGame: true });
    expect(sanitizeStats({ isDefaultGame: false }, GLOBAL)).toEqual({ isDefaultGame: false });
  });

  // The boolean branch used to run BEFORE the clamp below, so a boolean on any
  // key skipped it entirely. node-sqlite3 binds false as integer 0, and the
  // record columns merge with MIN — so `fastestWinTurns: false` pinned the
  // best-ever turn count at 0 with no path back short of editing the database.
  // Booleans are dropped rather than coerced for the same reason arrays are:
  // no legitimate client sends one for a counter (every other field on
  // GlobalStatsPayload is number or null), so one arriving is a malformed
  // payload, not a value to rescue.
  it('drops a boolean on a numeric field instead of letting it bypass the clamp', () => {
    expect(sanitizeStats({ fastestWinTurns: false }, DEVICE)).toEqual({});
    expect(sanitizeStats({ fastestLossTurns: false }, DEVICE)).toEqual({});
    expect(sanitizeStats({ fastestWinTurns: true }, DEVICE)).toEqual({});
  });

  it('drops booleans on counter and record fields, keeping the rest of the payload', () => {
    expect(sanitizeStats({ wins: true, busts: false, highestTurnScore: true, keep: 7 }, DEVICE))
      .toEqual({ keep: 7 });
  });

  it('drops a boolean without disturbing isDefaultGame in the same payload', () => {
    expect(sanitizeStats({ isDefaultGame: false, fastestWinTurns: false, gamesPlayed: 1 }, GLOBAL))
      .toEqual({ isDefaultGame: false, gamesPlayed: 1 });
  });

  it('preserves explicit nulls (e.g. fastestWinTurns)', () => {
    expect(sanitizeStats({ fastestWinTurns: null }, DEVICE)).toEqual({ fastestWinTurns: null });
  });

  it('floors fractional numbers', () => {
    expect(sanitizeStats({ totalScore: 12.9 }, DEVICE)).toEqual({ totalScore: 12 });
  });

  it('clamps negative numbers up to zero', () => {
    expect(sanitizeStats({ busts: -5 }, DEVICE)).toEqual({ busts: 0 });
  });

  it('keeps a legitimately negative totalScore (modernized scores go below zero)', () => {
    // Plus/Minus deductions are unclamped under modernized rules, so a
    // player can FINISH negative — flooring that at 0 silently inflated
    // every totalScore sum and average built on it.
    //
    // Its negative bound stays at STATS_VALUE_CAP while the positive one
    // tightened to the additive bound below, and deliberately so: totalScore
    // is the only field not floored at 0, which makes a negative value the
    // only way an operator can SUBTRACT a poisoned total back out through the
    // token-gated route. Tightening that direction would take the repair tool
    // away along with the attack.
    expect(sanitizeStats({ totalScore: -3000 }, DEVICE)).toEqual({ totalScore: -3000 });
    expect(sanitizeStats({ totalScore: -2e12 }, DEVICE)).toEqual({ totalScore: -STATS_VALUE_CAP });
    expect(sanitizeStats({ totalScore: -2e12 }, GLOBAL)).toEqual({ totalScore: -STATS_VALUE_CAP });
  });

  it('caps absurdly large numbers', () => {
    expect(sanitizeStats({ totalScore: 1e15 }, DEVICE)).toEqual({ totalScore: MAX_SCORE_MAGNITUDE });
  });

  it('coerces numeric strings', () => {
    expect(sanitizeStats({ gamesPlayed: '3' }, DEVICE)).toEqual({ gamesPlayed: 3 });
  });

  it('drops non-finite / non-numeric values', () => {
    expect(sanitizeStats({ a: 'abc', b: NaN, c: Infinity, d: {}, keep: 7 }, DEVICE)).toEqual({ keep: 7 });
  });

  it('drops arrays instead of coercing them via Array.prototype.toString (SA-3)', () => {
    // Number([42]) === 42 and Number([]) === 0 — both would otherwise slip
    // past a bare Number(val)/Number.isFinite check as valid stats.
    expect(sanitizeStats({ totalScore: [42], busts: [], keep: 7 }, DEVICE)).toEqual({ keep: 7 });
  });

  it('handles a realistic mixed payload', () => {
    expect(sanitizeStats({
      gamesPlayed: 1,
      wins: 1,
      totalScore: 5432.7,
      busts: -2,
      isDefaultGame: true,
      fastestWinTurns: null,
      bogus: 'x',
    }, DEVICE)).toEqual({
      gamesPlayed: 1,
      wins: 1,
      totalScore: 5432,
      busts: 0,
      isDefaultGame: true,
      fastestWinTurns: null,
    });
  });

  it('drops a non-positive fastestWinTurns/fastestLossTurns instead of clamping it', () => {
    // 1 is the BEST turn count either record can hold, and both columns are
    // MIN-merged — so clamping 0 (or a negative) UP to 1 wrote an unbeatable
    // record from a value that says nothing at all, with no way back short of
    // editing the database. Unreachable on the socket path, where the handler
    // derives both fields from the frozen verdict; live on the token-gated
    // HTTP POSTs, which sanitize whatever body they are given.
    expect(sanitizeStats({ fastestWinTurns: 0 }, DEVICE)).toEqual({});
    expect(sanitizeStats({ fastestLossTurns: 0 }, DEVICE)).toEqual({});
    expect(sanitizeStats({ fastestWinTurns: -3 }, DEVICE)).toEqual({});
    expect(sanitizeStats({ fastestLossTurns: -3 }, DEVICE)).toEqual({});
    // Floored first, so a fraction below one is just as absent.
    expect(sanitizeStats({ fastestWinTurns: 0.5 }, DEVICE)).toEqual({});
  });

  it('keeps a real fastest-turn record, and drops only the unusable field', () => {
    expect(sanitizeStats({ fastestWinTurns: 5 }, DEVICE)).toEqual({ fastestWinTurns: 5 });
    expect(sanitizeStats({ fastestLossTurns: 5 }, DEVICE)).toEqual({ fastestLossTurns: 5 });
    expect(sanitizeStats({ fastestLossTurns: 0, busts: 2 }, DEVICE)).toEqual({ busts: 2 });
  });

  it('leaves the MIN-merged records unbounded above, unlike the MAX-merged ones', () => {
    // Deliberately asymmetric. A huge value never poisons a MIN column — it
    // simply loses the merge — so dropping one would buy nothing, and raising
    // it toward MIN_RECORD_TURNS is precisely the unbeatable-record bug the
    // test above exists to prevent. Only the general STATS_VALUE_CAP applies.
    expect(sanitizeStats({ fastestWinTurns: 1e15 }, DEVICE)).toEqual({ fastestWinTurns: STATS_VALUE_CAP });
    expect(sanitizeStats({ fastestLossTurns: 1e15 }, GLOBAL)).toEqual({ fastestLossTurns: STATS_VALUE_CAP });
  });

  // Generated from the table sanitize.ts publishes, the way database.test.ts
  // generates its cases from RECORD_COLUMNS: a column added there arrives
  // covered here instead of silently keeping the old 1e9 ceiling.
  describe.each([...RECORD_STATS_BOUNDS])('the %s record column', (field, bound) => {
    it('drops a value past its honest ceiling rather than clamping it', () => {
      // Clamping would still WRITE something, and every column here is
      // MAX-merged: a host who plays a real game to a legitimate finish would
      // just pin the record at the clamp instead of at STATS_VALUE_CAP, and
      // nothing short of editing the database takes it back down. Writing
      // nothing leaves the record where the last honest game left it.
      expect(sanitizeStats({ [field]: bound + 1 }, DEVICE)).toEqual({});
      expect(sanitizeStats({ [field]: bound + 1 }, GLOBAL)).toEqual({});
      expect(sanitizeStats({ [field]: STATS_VALUE_CAP }, DEVICE)).toEqual({});
    });

    it('keeps a value at the ceiling, and the rest of the payload when it drops one', () => {
      expect(sanitizeStats({ [field]: bound }, DEVICE)).toEqual({ [field]: bound });
      expect(sanitizeStats({ [field]: bound + 1, busts: 2 }, DEVICE)).toEqual({ busts: 2 });
    });
  });

  it('bounds each additive family by its own source ceiling, not one shared maximum', () => {
    // One max-over-all-three bound had to clear the largest family, so the two
    // smaller ones were bounded by the largest one's ceiling — a device row
    // accepted a totalScore ten times MAX_SCORE_MAGNITUDE and a totalTurns a
    // hundred times MAX_ROUNDS, neither of which any game can produce.
    expect(sanitizeStats({ totalPlaytime: 1e15 }, DEVICE)).toEqual({ totalPlaytime: MAX_GAME_SECONDS });
    expect(sanitizeStats({ totalScore: 1e15 }, DEVICE)).toEqual({ totalScore: MAX_SCORE_MAGNITUDE });
    expect(sanitizeStats({ totalTurns: 1e15 }, DEVICE)).toEqual({ totalTurns: MAX_ROUNDS });
  });

  it('multiplies only the genuinely per-seat families by the room cap on a global row', () => {
    // A global row's counts and scores ARE sums over every seat that played
    // (buildGlobalStatsPayload adds each player's up), so an identical key
    // legitimately holds up to MAX_PLAYERS_PER_ROOM times as much there.
    expect(sanitizeStats({ totalScore: 1e15 }, GLOBAL))
      .toEqual({ totalScore: MAX_SCORE_MAGNITUDE * MAX_PLAYERS_PER_ROOM });
    expect(sanitizeStats({ totalTurns: 1e15 }, GLOBAL))
      .toEqual({ totalTurns: MAX_ROUNDS * MAX_PLAYERS_PER_ROOM });
    // A full room's summed score is legitimately far past one player's own, so
    // the global row must not inherit the device bound.
    expect(sanitizeStats({ totalScore: MAX_SCORE_MAGNITUDE * 2 }, GLOBAL))
      .toEqual({ totalScore: MAX_SCORE_MAGNITUDE * 2 });
    // The duration is the exception, and the reason the multiplier is not
    // applied family-blind: totalPlaytime is the GAME's own elapsed time in
    // both payloads (buildGlobalStatsPayload passes finalTime straight
    // through), never a per-seat sum, so multiplying it by the room cap would
    // buy a hundredfold headroom no submission can use — and it is exactly
    // that product that reached STATS_VALUE_CAP and made the whole global
    // bound a no-op.
    expect(sanitizeStats({ totalPlaytime: 1e15 }, GLOBAL)).toEqual({ totalPlaytime: MAX_GAME_SECONDS });
  });

  it('keeps every additive bound strictly below the general cap', () => {
    // The bound this replaced was arithmetically an identity on the global
    // path: max(MAX_GAME_SECONDS, MAX_SCORE_MAGNITUDE, MAX_ROUNDS) is 1e7 and
    // 1e7 * MAX_PLAYERS_PER_ROOM is EXACTLY STATS_VALUE_CAP, so
    // Math.min(maxAllowed, capped) changed nothing and a host could still
    // write `totalScore: 1e9` into the public per-ruleset row. The test that
    // stood here could not see it, because it restated the multiplication the
    // source line already made and both sides were the same number. Asserting
    // the inequality instead is what makes the degeneration visible.
    for (const scope of [DEVICE, GLOBAL]) {
      for (const [key, bound] of ADDITIVE_STATS_BOUNDS[scope]) {
        expect(bound, `${scope}/${key}`).toBeLessThan(STATS_VALUE_CAP);
      }
    }
  });

  it('refuses a whole-cap totalScore on the public per-ruleset row', () => {
    // The concrete write the no-op above left open: a host plays a real game
    // to a legitimate finish and submits 1e9 as the room's summed score.
    expect(sanitizeStats({ totalScore: STATS_VALUE_CAP }, GLOBAL))
      .toEqual({ totalScore: MAX_SCORE_MAGNITUDE * MAX_PLAYERS_PER_ROOM });
  });

  it('leaves gamesPlayed and wins out of the additive bound', () => {
    // The token-gated admin route (POST /api/stats/:deviceId) legitimately
    // corrects a miscount in one multi-game call rather than one game at a
    // time, and api.routes.test.ts + api.test.ts pin that. Both are plain
    // additive columns — nothing they carry is permanent, so the same route
    // can subtract it again — which is what makes the exemption safe.
    const pastEveryAdditiveBound = MAX_GAME_SECONDS * MAX_PLAYERS_PER_ROOM;
    expect(sanitizeStats({ gamesPlayed: pastEveryAdditiveBound }, DEVICE))
      .toEqual({ gamesPlayed: pastEveryAdditiveBound });
    expect(sanitizeStats({ wins: pastEveryAdditiveBound }, DEVICE))
      .toEqual({ wins: pastEveryAdditiveBound });
    expect(sanitizeStats({ gamesPlayed: 1e15 }, DEVICE)).toEqual({ gamesPlayed: STATS_VALUE_CAP });
  });
});

/**
 * The bound tables against the columns they are supposed to be bounding.
 *
 * sanitize.ts never imported RECORD_COLUMNS, and the generated cases above run
 * off RECORD_STATS_BOUNDS — the side that would be MISSING a new entry. Adding
 * a MAX column to RECORD_COLUMNS and forgetting this table left the new
 * permanent record on the general 1e9 ceiling with every test still green,
 * which is the hand-maintained-key-list failure this repo locks everywhere
 * else. Checked here rather than as a compile-time lock because sanitize.ts is
 * on server/api.ts's module graph and database.ts builds a knex instance at
 * import: the type-level version would drag that in for a check a test makes
 * just as loudly.
 */
describe('the record bound tables cover every record column', () => {
  const columnsMergedWith = (agg: 'MAX' | 'MIN'): string[] =>
    RECORD_COLUMNS.filter(([, columnAgg]) => columnAgg === agg).map(([col]) => col);

  it('gives every MAX-merged column an honest ceiling', () => {
    const unbounded = columnsMergedWith('MAX').filter(col => !RECORD_STATS_BOUNDS.has(col));
    expect(unbounded).toEqual([]);
  });

  it('gives every MIN-merged column the drop-below-one rule', () => {
    const unguarded = columnsMergedWith('MIN').filter(col => !MIN_RECORD_STATS_FIELDS.has(col));
    expect(unguarded).toEqual([]);
  });

  it('bounds nothing that is not a record column at all', () => {
    // The other direction: a bound left behind for a column that has since
    // been dropped or turned additive reads like protection and is inert.
    const columns = new Set(RECORD_COLUMNS.map(([col]) => col));
    expect([...RECORD_STATS_BOUNDS.keys()].filter(key => !columns.has(key))).toEqual([]);
    expect([...MIN_RECORD_STATS_FIELDS].filter(key => !columns.has(key))).toEqual([]);
  });
});

// The line terminators this module has to treat like CR/LF, built from
// char codes so the source stays pure ASCII: written as raw characters
// they are invisible in a diff and an editor can silently normalise them
// away, leaving every assertion below comparing a string to itself.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x0085);

describe('sanitizeLogHeaderField', () => {
  it('strips CR/LF so a crafted field cannot forge extra log lines', () => {
    expect(sanitizeLogHeaderField('2026-01-01\n[client-error] forged entry')).toBe('2026-01-01 [client-error] forged entry');
    expect(sanitizeLogHeaderField('a\r\nb\rc\nd')).toBe('a b c d');
  });

  // Stripping CR/LF alone does not achieve what this function exists for: an
  // ANSI cursor sequence rewrites log lines that were ALREADY written, so a
  // crafted field can erase or overwrite genuine entries in a live terminal
  // without ever emitting a newline of its own.
  it('strips ANSI escape sequences so a crafted field cannot rewrite earlier log lines', () => {
    // CUU (cursor up) + EL (erase line): moves onto the previous entry and
    // blanks it, then writes its own text over the top.
    expect(sanitizeLogHeaderField('boom\x1b[1A\x1b[2Kforged entry')).toBe('boomforged entry');
    expect(sanitizeLogHeaderField('\x1b[31mred\x1b[0m')).toBe('red');
  });

  // The CR/LF rule above and the control-character sweep below leave a gap
  // between them: U+0085 sits past the \x7f that class stops at, and U+2028/
  // U+2029 are well beyond it. Log viewers and editors that treat those as
  // line terminators render a crafted field as its own top-level entry.
  //
  // Written as \u escapes rather than literal characters: the raw ones are
  // invisible in a diff and an editor can normalise them away, which would
  // leave every assertion here comparing a plain string to itself.
  it('strips the Unicode line separators as well as CR/LF', () => {
    expect(sanitizeLogHeaderField(`2026-01-01${LS}[client-error] forged`)).toBe('2026-01-01 [client-error] forged');
    expect(sanitizeLogHeaderField(`a${PS}b`)).toBe('a b');
    expect(sanitizeLogHeaderField(`a${NEL}b`)).toBe('a b');
    // Collapsed as a single run, exactly like a \r\n pair.
    expect(sanitizeLogHeaderField(`a${LS}${PS}${NEL}\r\nb`)).toBe('a b');
  });

  it('indents continuation lines split by a Unicode separator too', () => {
    // The stack-trace path keeps its newlines and indents them, so a forged
    // "[client-error] ..." line cannot sit flush at the start of a line.
    expect(indentLogContinuationLines(`at foo${LS}[client-error] forged`))
      .toBe('at foo\n    [client-error] forged');
    expect(indentLogContinuationLines(`at foo${NEL}at bar`)).toBe('at foo\n    at bar');
  });

  it('strips NUL and other control characters a log reader would act on', () => {
    // A NUL truncates the line in several log processors; BEL, backspace and a
    // bare ESC survive the CSI pattern the previous test covers.
    expect(sanitizeLogHeaderField('visible\x00hidden')).toBe('visiblehidden');
    expect(sanitizeLogHeaderField('a\x07b\x1bc\x08d')).toBe('abcd');
  });

  it('leaves single-line values untouched', () => {
    expect(sanitizeLogHeaderField('plain message, no newlines')).toBe('plain message, no newlines');
    // Tab is the one control character kept: it cannot forge an entry, and
    // stripping it would mangle legitimately tab-separated messages.
    expect(sanitizeLogHeaderField('col1\tcol2')).toBe('col1\tcol2');
    expect(sanitizeLogHeaderField('')).toBe('');
  });
});

describe('indentLogContinuationLines', () => {
  it('indents every continuation line so none can masquerade as a top-level entry', () => {
    expect(indentLogContinuationLines('Error: boom\n[client-error] forged\nat Game'))
      .toBe('Error: boom\n    [client-error] forged\n    at Game');
  });

  it('normalizes CRLF line endings while indenting', () => {
    expect(indentLogContinuationLines('line1\r\nline2')).toBe('line1\n    line2');
  });

  // A stack trace is exactly as attacker-controlled as the header fields and
  // lands in the same log, so it gets the same treatment — indenting a line
  // does not stop an ANSI sequence inside it from walking the cursor back up
  // over entries already written.
  it('strips ANSI escapes and control characters while keeping the line structure', () => {
    expect(indentLogContinuationLines('Error: boom\x1b[1A\nat Game\x00'))
      .toBe('Error: boom\n    at Game');
    expect(indentLogContinuationLines('\x1b[31mError\x1b[0m\nat DiceGame'))
      .toBe('Error\n    at DiceGame');
  });

  it('leaves single-line values untouched', () => {
    expect(indentLogContinuationLines('at DiceGame')).toBe('at DiceGame');
    expect(indentLogContinuationLines('')).toBe('');
  });
});
