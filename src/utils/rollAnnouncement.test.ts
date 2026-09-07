/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { describeLandedRoll } from './rollAnnouncement';

describe('describeLandedRoll', () => {
  it('scores a plain bonus card table with 1s and 5s', () => {
    // Two 1s (200) plus one 5 (50) score; 2/3/4 are unscored singles.
    const result = describeLandedRoll({
      rollVals: [1, 1, 5, 2, 3, 4],
      currentCard: '200',
      kniffelProgress: [],
      ruleset: 'modernized',
      keptCount: 0,
    });
    expect(result).toEqual({ scoringCount: 3, score: 250, completesTutto: false });
  });

  it('scores a triple on a bonus card', () => {
    const result = describeLandedRoll({
      rollVals: [2, 2, 2, 3, 4, 6],
      currentCard: '200',
      kniffelProgress: [],
      ruleset: 'modernized',
      keptCount: 0,
    });
    expect(result).toEqual({ scoringCount: 3, score: 200, completesTutto: false });
  });

  it('reports completesTutto when the kept dice plus this roll fill the table', () => {
    const result = describeLandedRoll({
      rollVals: [2, 2, 2, 3, 4, 6],
      currentCard: '200',
      kniffelProgress: [],
      ruleset: 'modernized',
      keptCount: 3,
    });
    expect(result.completesTutto).toBe(true);
  });

  // Kniffel has no dice value on the board — checkValidityAndScore returns
  // score: 0 for it (diceLogic.ts:119-124), which is a phantom number, not
  // the card's real award (KNIFFEL_SCORE, applied only on completion). The
  // announcement says how many dice count, never a score.
  it('returns a null score for Kniffel, with the count of dice that count toward the straight', () => {
    const result = describeLandedRoll({
      rollVals: [1, 2, 3, 4, 5, 6],
      currentCard: 'Kniffel',
      kniffelProgress: [],
      ruleset: 'modernized',
      keptCount: 0,
    });
    expect(result).toEqual({ scoringCount: 6, score: null, completesTutto: true });
  });

  // Plus/Minus discards its dice outright (DiceGame's countsDicePoints /
  // FIXED_CARD_AWARD) — no dice value exists for it either.
  it('returns a null score for Plus/Minus, with the count of dice that count toward the card', () => {
    const result = describeLandedRoll({
      rollVals: [1, 1, 1, 5, 5, 2],
      currentCard: 'Plus_Minus',
      kniffelProgress: [],
      ruleset: 'modernized',
      keptCount: 0,
    });
    expect(result).toEqual({ scoringCount: 5, score: null, completesTutto: false });
  });

  it('counts every scoring die on a classic Feuerwerk roll, with its real dice value', () => {
    const result = describeLandedRoll({
      rollVals: [1, 5, 2, 2, 2, 3],
      currentCard: 'Feuerwerk',
      kniffelProgress: [],
      ruleset: 'classic',
      keptCount: 0,
    });
    expect(result).toEqual({ scoringCount: 5, score: 350, completesTutto: false });
  });

  // The hook never calls this for a busting roll (the alert banner speaks
  // instead), but the util itself must not throw on one.
  it('returns a zero count and a zero score for a bust table, without throwing', () => {
    const result = describeLandedRoll({
      rollVals: [2, 3, 4, 6, 2, 3],
      currentCard: '200',
      kniffelProgress: [],
      ruleset: 'modernized',
      keptCount: 0,
    });
    expect(result).toEqual({ scoringCount: 0, score: 0, completesTutto: false });
  });
});
