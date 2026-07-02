import { describe, it, expect } from 'vitest';
import { getEffectiveTurnDuration } from './turnDuration';

describe('getEffectiveTurnDuration', () => {
  it('triples the duration for Feuerwerk', () => {
    expect(getEffectiveTurnDuration('Feuerwerk', 120)).toBe(360);
  });

  it('doubles the duration for Kleeblatt', () => {
    expect(getEffectiveTurnDuration('Kleeblatt', 120)).toBe(240);
  });

  it('keeps the base duration for every other card', () => {
    expect(getEffectiveTurnDuration('200', 120)).toBe(120);
    expect(getEffectiveTurnDuration('x2', 120)).toBe(120);
    expect(getEffectiveTurnDuration('Stop', 120)).toBe(120);
    expect(getEffectiveTurnDuration('Kniffel', 120)).toBe(120);
    expect(getEffectiveTurnDuration('Plus_Minus', 120)).toBe(120);
  });

  it('keeps the base duration when no card is drawn', () => {
    expect(getEffectiveTurnDuration(null, 120)).toBe(120);
  });

  it('leaves a disabled (0) duration disabled regardless of card', () => {
    expect(getEffectiveTurnDuration('Feuerwerk', 0)).toBe(0);
  });
});
