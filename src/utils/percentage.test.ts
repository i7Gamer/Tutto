/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { percentageOf } from './percentage';

describe('percentageOf', () => {
  it('gives a whole-number percentage', () => {
    expect(percentageOf(3, 5)).toBe(60);
    expect(percentageOf(0, 5)).toBe(0);
    expect(percentageOf(5, 5)).toBe(100);
  });

  it('rounds to the nearest whole number', () => {
    // Statistics are read at a glance; a bust rate of 23.333% is noise.
    expect(percentageOf(7, 30)).toBe(23);
    expect(percentageOf(2, 3)).toBe(67);
  });

  it('says nothing rather than zero when there is nothing to divide by', () => {
    // "0% wins" and "no games played yet" are different statements, and the
    // caller is the one that knows which of them to show.
    expect(percentageOf(0, 0)).toBeNull();
    expect(percentageOf(5, 0)).toBeNull();
    expect(percentageOf(1, -3)).toBeNull();
  });
});
