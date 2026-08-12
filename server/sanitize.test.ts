/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { sanitizeStats, sanitizeLogHeaderField, indentLogContinuationLines, STATS_VALUE_CAP } from './sanitize';

describe('sanitizeStats', () => {
  it('returns an empty object for non-object input', () => {
    expect(sanitizeStats(null)).toEqual({});
    expect(sanitizeStats(undefined)).toEqual({});
    expect(sanitizeStats('nope')).toEqual({});
    expect(sanitizeStats(42)).toEqual({});
  });

  it('passes through booleans (e.g. isDefaultGame)', () => {
    expect(sanitizeStats({ isDefaultGame: true, other: false })).toEqual({ isDefaultGame: true, other: false });
  });

  it('preserves explicit nulls (e.g. fastestWinTurns)', () => {
    expect(sanitizeStats({ fastestWinTurns: null })).toEqual({ fastestWinTurns: null });
  });

  it('floors fractional numbers', () => {
    expect(sanitizeStats({ totalScore: 12.9 })).toEqual({ totalScore: 12 });
  });

  it('clamps negative numbers up to zero', () => {
    expect(sanitizeStats({ busts: -5 })).toEqual({ busts: 0 });
  });

  it('keeps a legitimately negative totalScore (modernized scores go below zero)', () => {
    // Plus/Minus deductions are unclamped under modernized rules, so a
    // player can FINISH negative — flooring that at 0 silently inflated
    // every totalScore sum and average built on it.
    expect(sanitizeStats({ totalScore: -3000 })).toEqual({ totalScore: -3000 });
    expect(sanitizeStats({ totalScore: -2e12 })).toEqual({ totalScore: -STATS_VALUE_CAP });
  });

  it('caps absurdly large numbers', () => {
    expect(sanitizeStats({ totalScore: 1e15 })).toEqual({ totalScore: STATS_VALUE_CAP });
  });

  it('coerces numeric strings', () => {
    expect(sanitizeStats({ gamesPlayed: '3' })).toEqual({ gamesPlayed: 3 });
  });

  it('drops non-finite / non-numeric values', () => {
    expect(sanitizeStats({ a: 'abc', b: NaN, c: Infinity, d: {}, keep: 7 })).toEqual({ keep: 7 });
  });

  it('drops arrays instead of coercing them via Array.prototype.toString (SA-3)', () => {
    // Number([42]) === 42 and Number([]) === 0 — both would otherwise slip
    // past a bare Number(val)/Number.isFinite check as valid stats.
    expect(sanitizeStats({ totalScore: [42], busts: [], keep: 7 })).toEqual({ keep: 7 });
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
    })).toEqual({
      gamesPlayed: 1,
      wins: 1,
      totalScore: 5432,
      busts: 0,
      isDefaultGame: true,
      fastestWinTurns: null,
    });
  });

  it('clamps fastestWinTurns and fastestLossTurns to >= 1', () => {
    expect(sanitizeStats({ fastestWinTurns: 0 })).toEqual({ fastestWinTurns: 1 });
    expect(sanitizeStats({ fastestLossTurns: 0 })).toEqual({ fastestLossTurns: 1 });
  });
});

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
