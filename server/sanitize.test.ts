/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeStats, sanitizeLogHeaderField, indentLogContinuationLines,
  STATS_VALUE_CAP, RECORD_STATS_BOUNDS,
  MAX_ADDITIVE_PER_PLAYER, MAX_ADDITIVE_PER_GLOBAL_ROW,
  type StatsScope,
} from './sanitize';
import { MAX_PLAYERS_PER_ROOM } from '../src/utils/configValidation';

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
    expect(sanitizeStats({ totalScore: 1e15 }, DEVICE)).toEqual({ totalScore: MAX_ADDITIVE_PER_PLAYER });
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

  it('bounds an additive counter per player on a device row and per room on a global one', () => {
    // The same key means different things per row shape: totalPlaytime is one
    // player's on a device row, but a sum over every seat that played on a
    // global one. One shared cap is either useless on the first or lossy on
    // the second, which is why the scope has to be passed in.
    expect(sanitizeStats({ totalPlaytime: 1e15 }, DEVICE))
      .toEqual({ totalPlaytime: MAX_ADDITIVE_PER_PLAYER });
    expect(sanitizeStats({ totalPlaytime: 1e15 }, GLOBAL))
      .toEqual({ totalPlaytime: MAX_ADDITIVE_PER_GLOBAL_ROW });
    // A full room's summed playtime is legitimately far past one player's own,
    // so the global row must not inherit the device bound.
    expect(sanitizeStats({ totalPlaytime: MAX_ADDITIVE_PER_PLAYER * 2 }, GLOBAL))
      .toEqual({ totalPlaytime: MAX_ADDITIVE_PER_PLAYER * 2 });
  });

  it('derives the global bound from the per-player one and the room cap', () => {
    // Stated as the multiplication rather than as a literal: a change to
    // either factor must carry through instead of leaving a stale number here.
    expect(MAX_ADDITIVE_PER_GLOBAL_ROW).toBe(MAX_ADDITIVE_PER_PLAYER * MAX_PLAYERS_PER_ROOM);
  });

  it('leaves gamesPlayed and wins out of the additive bound', () => {
    // The token-gated admin route (POST /api/stats/:deviceId) legitimately
    // corrects a miscount in one multi-game call rather than one game at a
    // time, and api.routes.test.ts + api.test.ts pin that. Both are plain
    // additive columns — nothing they carry is permanent, so the same route
    // can subtract it again — which is what makes the exemption safe.
    expect(sanitizeStats({ gamesPlayed: MAX_ADDITIVE_PER_PLAYER * 2 }, DEVICE))
      .toEqual({ gamesPlayed: MAX_ADDITIVE_PER_PLAYER * 2 });
    expect(sanitizeStats({ wins: MAX_ADDITIVE_PER_PLAYER * 2 }, DEVICE))
      .toEqual({ wins: MAX_ADDITIVE_PER_PLAYER * 2 });
    expect(sanitizeStats({ gamesPlayed: 1e15 }, DEVICE)).toEqual({ gamesPlayed: STATS_VALUE_CAP });
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
