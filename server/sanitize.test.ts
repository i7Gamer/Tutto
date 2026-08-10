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

  it('leaves single-line values untouched', () => {
    expect(sanitizeLogHeaderField('plain message, no newlines')).toBe('plain message, no newlines');
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

  it('leaves single-line values untouched', () => {
    expect(indentLogContinuationLines('at DiceGame')).toBe('at DiceGame');
    expect(indentLogContinuationLines('')).toBe('');
  });
});
