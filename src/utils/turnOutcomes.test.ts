import { describe, expect, it } from 'vitest';
import { isTurnCardOutcomeList, copyTurnCardOutcomes, recordCurrentOutcome } from './turnOutcomes';
import { MAX_CHAIN_CARDS } from '../types';
import { MAX_SCORE_MAGNITUDE } from './configValidation';

const first = { card: '200' as const, scoreBefore: 0, scoreAfter: 500, tuttos: 1 };

describe('per-card outcome journal', () => {
  it('updates only the active card and counts repeated Feuerwerk tuttos', () => {
    const outcomes = [first, { card: 'Feuerwerk' as const, scoreBefore: 500, scoreAfter: 500, tuttos: 0 }];
    recordCurrentOutcome(outcomes, 1000, 1);
    recordCurrentOutcome(outcomes, 1500, 1);
    recordCurrentOutcome(outcomes, 1600);
    expect(outcomes).toEqual([first, { card: 'Feuerwerk', scoreBefore: 500, scoreAfter: 1600, tuttos: 2 }]);
    expect(() => recordCurrentOutcome([], 0)).not.toThrow();
  });

  it('copies only the public outcome fields without aliases', () => {
    const outcomes = [{ ...first, ignored: 'private' }];
    const copied = copyTurnCardOutcomes(outcomes);
    expect(copied).toEqual([first]);
    expect(copied[0]).not.toBe(outcomes[0]);
  });

  it('accepts bounded reports without claiming they prove dice outcomes', () => {
    expect(isTurnCardOutcomeList([first])).toBe(true);
    expect(isTurnCardOutcomeList([])).toBe(true);
    expect(isTurnCardOutcomeList([{ ...first, scoreAfter: MAX_SCORE_MAGNITUDE, tuttos: MAX_CHAIN_CARDS }])).toBe(true);
  });

  it.each([null, {}, [null], [{ ...first, card: 'invalid' }], [{ ...first, scoreBefore: -1 }],
    [{ ...first, scoreAfter: Infinity }], [{ ...first, scoreAfter: MAX_SCORE_MAGNITUDE + 1 }],
    [{ ...first, tuttos: 0.5 }], [{ ...first, tuttos: MAX_CHAIN_CARDS + 1 }],
    Array.from({ length: MAX_CHAIN_CARDS + 1 }, () => first),
  ])('refuses malformed journals %j', value => { expect(isTurnCardOutcomeList(value)).toBe(false); });
});
