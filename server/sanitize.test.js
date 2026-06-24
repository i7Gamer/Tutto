/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { sanitizeStats, STATS_VALUE_CAP } from './sanitize.js';

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

  it('caps absurdly large numbers', () => {
    expect(sanitizeStats({ totalScore: 1e15 })).toEqual({ totalScore: STATS_VALUE_CAP });
  });

  it('coerces numeric strings', () => {
    expect(sanitizeStats({ gamesPlayed: '3' })).toEqual({ gamesPlayed: 3 });
  });

  it('drops non-finite / non-numeric values', () => {
    expect(sanitizeStats({ a: 'abc', b: NaN, c: Infinity, d: {}, keep: 7 })).toEqual({ keep: 7 });
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
});
