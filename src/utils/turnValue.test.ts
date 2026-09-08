/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  diceCounts, legalKeeps, rollOutcomes, tableOutcomes, completionProbability, rollOnValue,
  continuationValue, tuttoValue, kleeblattWinValue, keepIndices, onePlyValue,
  type Keep, type ValueContext,
} from './turnValue';
import { checkValidityAndScore, isBust } from './diceLogic';
import { KNIFFEL_SCORE, PLUS_MINUS_SCORE } from './coreGameEngine';
import { DIE_FACES, TOTAL_DICE } from './turnShapes';
import type { CardType, Ruleset } from '../types';

const counts = (...vals: number[]) => diceCounts(vals);
const keepVals = (keep: Keep): number[] => keep.counts.flatMap((c, i) => Array<number>(c).fill(i + 1));
const keepStrings = (keeps: Keep[]): string[] => keeps.map(k => keepVals(k).join('')).sort();
const outcomeSpace = (dice: number): number => DIE_FACES ** dice;

const vctx = (overrides: Partial<ValueContext> = {}): ValueContext => ({
  card: '200',
  ruleset: 'modernized',
  myScore: 0,
  winningScore: 6000,
  tuttosThisTurn: 0,
  ...overrides,
});

// A deterministic generator so the property runs are repeatable.
const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

describe('rollOutcomes', () => {
  // Multisets of n dice over 6 faces: C(n + 5, 5) of them.
  const MULTISET_COUNTS = [6, 21, 56, 126, 252, 462];

  it('enumerates every multiset once, with multiplicities that add up to 6^n', () => {
    for (let dice = 1; dice <= TOTAL_DICE; dice++) {
      const outcomes = rollOutcomes(dice);
      expect(outcomes).toHaveLength(MULTISET_COUNTS[dice - 1]);
      expect(outcomes.reduce((sum, o) => sum + o.multiplicity, 0)).toBe(outcomeSpace(dice));
      outcomes.forEach(o => expect(o.counts.reduce((a, b) => a + b, 0)).toBe(dice));
    }
  });

  it('weights a 1-and-5 pair by the two orders it can land in', () => {
    const pair = rollOutcomes(2).find(o => o.counts[0] === 1 && o.counts[4] === 1);
    expect(pair?.multiplicity).toBe(2);
  });
});

describe('legalKeeps', () => {
  it('offers every valid subset of a points table: the 1 alone, the triple alone, or both', () => {
    const keeps = legalKeeps(counts(1, 2, 2, 2, 3, 4), '200', [], 'modernized');
    expect(keepStrings(keeps)).toEqual(['1', '1222', '222']);
    const byVals = Object.fromEntries(keeps.map(k => [keepVals(k).join(''), k]));
    expect(byVals['1']).toMatchObject({ dice: 1, score: 100 });
    expect(byVals['222']).toMatchObject({ dice: 3, score: 200 });
    expect(byVals['1222']).toMatchObject({ dice: 4, score: 300 });
  });

  it('lets a pair of 1s be kept one at a time', () => {
    expect(keepStrings(legalKeeps(counts(1, 1, 2, 3, 4, 6), '200', [], 'modernized'))).toEqual(['1', '11']);
  });

  it('keeps triples whole: six 2s are one triple or two', () => {
    const keeps = legalKeeps(counts(2, 2, 2, 2, 2, 2), '200', [], 'modernized');
    expect(keepStrings(keeps)).toEqual(['222', '222222']);
    expect(keeps.map(k => k.score).sort((a, b) => a - b)).toEqual([200, 400]);
  });

  it('scores four 1s as a thousand plus a hundred, and offers every count of them', () => {
    const keeps = legalKeeps(counts(1, 1, 1, 1, 2, 3), '200', [], 'modernized');
    expect(keeps.map(k => k.score).sort((a, b) => a - b)).toEqual([100, 200, 1000, 1100]);
  });

  it('is empty on a bust table', () => {
    expect(legalKeeps(counts(2, 2, 3, 3, 4, 4), '200', [], 'modernized')).toEqual([]);
  });

  it('follows the dice rules, not the card, on Plus/Minus', () => {
    expect(keepStrings(legalKeeps(counts(1, 2, 2, 2, 3, 4), 'Plus_Minus', [], 'modernized')))
      .toEqual(['1', '1222', '222']);
  });

  it('offers a modernized Kniffel exactly its run', () => {
    const keeps = legalKeeps(counts(3, 1, 2, 6, 6, 4), 'Kniffel', [], 'modernized');
    expect(keeps).toHaveLength(1);
    expect(keepVals(keeps[0])).toEqual([1, 2, 3, 4]);
    expect(keeps[0]).toMatchObject({ dice: 4, score: 0, progressAfter: [1, 2, 3, 4] });
  });

  it('offers a classic Kniffel one die per missing number', () => {
    const keeps = legalKeeps(counts(5, 5), 'Kniffel', [1, 2, 3, 4], 'classic');
    expect(keeps).toHaveLength(1);
    expect(keeps[0]).toMatchObject({ dice: 1, progressAfter: [1, 2, 3, 4, 5] });
  });

  it('is empty when the Kniffel run cannot grow', () => {
    expect(legalKeeps(counts(6, 6, 6), 'Kniffel', [1, 2, 3], 'modernized')).toEqual([]);
  });

  it('never offers an empty keep and only ever offers valid ones', () => {
    const rand = lcg(3);
    const cards: (CardType | null)[] = ['200', 'x2', null, 'Plus_Minus', 'Kleeblatt', 'Feuerwerk', 'Kniffel'];
    const rulesets: Ruleset[] = ['modernized', 'classic'];
    for (let trial = 0; trial < 500; trial++) {
      const dice = 1 + Math.floor(rand() * TOTAL_DICE);
      const vals = Array.from({ length: dice }, () => 1 + Math.floor(rand() * DIE_FACES));
      const card = cards[Math.floor(rand() * cards.length)];
      const ruleset = rulesets[Math.floor(rand() * rulesets.length)];
      for (const keep of legalKeeps(diceCounts(vals), card, [], ruleset)) {
        expect(keep.dice).toBeGreaterThan(0);
        expect(checkValidityAndScore(keepVals(keep), card, [], ruleset).valid).toBe(true);
      }
    }
  });
});

describe('tableOutcomes', () => {
  const bustOdds = (dice: number, card: CardType | null, progress: number[], ruleset: Ruleset): number =>
    tableOutcomes(dice, card, progress, ruleset)
      .reduce((sum, o) => sum + (o.bust ? o.multiplicity : 0), 0) / outcomeSpace(dice);

  it('reproduces the raw enumeration\'s bust odds from the multisets', () => {
    expect(bustOdds(1, '200', [], 'modernized')).toBeCloseTo(4 / 6, 10);
    expect(bustOdds(2, '200', [], 'modernized')).toBeCloseTo(16 / 36, 10);
    // 1440 of the 46656 six-dice outcomes have no 1, no 5 and no triple — the
    // number that catches a wrong multinomial coefficient.
    expect(bustOdds(6, '200', [], 'modernized')).toBeCloseTo(1440 / 46656, 10);
    expect(bustOdds(6, 'Kniffel', [], 'classic')).toBe(0);
    expect(bustOdds(1, 'Kniffel', [1, 2, 3, 4, 5], 'classic')).toBeCloseTo(5 / 6, 10);
  });

  it('agrees with isBust on every outcome: a table busts exactly when it has no legal keep', () => {
    const cards: (CardType | null)[] = ['200', 'x2', null, 'Plus_Minus', 'Kleeblatt', 'Feuerwerk', 'Kniffel'];
    for (const card of cards) {
      for (let dice = 1; dice <= TOTAL_DICE; dice++) {
        for (const outcome of tableOutcomes(dice, card, [], 'modernized')) {
          const vals = outcome.counts.flatMap((c, i) => Array<number>(c).fill(i + 1));
          expect(outcome.bust).toBe(isBust(vals, card, [], 'modernized'));
          expect(outcome.keeps.length === 0).toBe(outcome.bust);
        }
      }
    }
  });
});

describe('completionProbability', () => {
  it('knows a lone die finishes Plus/Minus one time in three', () => {
    expect(completionProbability(1, 'Plus_Minus', [], 'modernized')).toBeCloseTo(1 / 3, 10);
  });

  it('keeps both dice of a scoring pair and one of a single, and adds the odds up', () => {
    // Two dice: both score (4/36) and finish; one scores (16/36) and leaves a
    // die that finishes one time in three; neither (16/36) busts.
    expect(completionProbability(2, 'Plus_Minus', [], 'modernized')).toBeCloseTo(28 / 108, 10);
  });

  it('is not monotone in the dice: one die is likeliest, then six, then five, and three is the worst', () => {
    // Three dice by hand: 12 of 216 finish at once (three scorers or a
    // triple), 48 leave one die after keeping two scorers, 96 leave two after
    // keeping one, 60 bust.
    const three = (12 + 48 * (1 / 3) + 96 * (28 / 108)) / 216;
    const odds = [1, 2, 3, 4, 5, 6].map(dice => completionProbability(dice, 'Plus_Minus', [], 'modernized'));
    expect(odds[2]).toBeCloseTo(three, 10);
    expect(odds[0]).toBeGreaterThan(odds[5]);
    expect(odds[5]).toBeGreaterThan(odds[4]);
    expect(odds[4]).toBeGreaterThan(odds[1]);
    expect(odds[1]).toBeGreaterThan(odds[2]);
    expect(Math.min(...odds)).toBe(odds[2]);
  });

  it('is the same arithmetic for a Kleeblatt tutto', () => {
    expect(completionProbability(2, 'Kleeblatt', [], 'modernized'))
      .toBe(completionProbability(2, 'Plus_Minus', [], 'modernized'));
  });

  it('follows the straight\'s progress on Kniffel', () => {
    expect(completionProbability(1, 'Kniffel', [1, 2, 3, 4, 5], 'classic')).toBeCloseTo(1 / 6, 10);
    expect(completionProbability(1, 'Kniffel', [1, 2, 3, 4, 5], 'modernized')).toBeCloseTo(1 / 6, 10);
    const fresh = completionProbability(TOTAL_DICE, 'Kniffel', [], 'modernized');
    expect(fresh).toBeGreaterThan(0);
    expect(fresh).toBeLessThan(1);
  });
});

describe('rollOnValue', () => {
  it('values the last die exactly: a 1 or a 5 makes the tutto with its bonus, anything else busts', () => {
    // Bank 300 on a 200 card: a 1 banks 300 + 100 + 200, a 5 banks 300 + 50 + 200.
    expect(rollOnValue(300, 1, '200', 'modernized')).toBeCloseTo((600 + 550) / 6, 10);
    // x2 doubles the tutto: 100 becomes 200, 50 becomes 100.
    expect(rollOnValue(0, 1, 'x2', 'modernized')).toBeCloseTo((200 + 100) / 6, 10);
  });

  it('reproduces the plan\'s probe numbers', () => {
    expect(Math.round(rollOnValue(100, 5, '200', 'modernized'))).toBe(369);
    expect(Math.round(rollOnValue(350, 1, '200', 'modernized'))).toBe(208);
    expect(Math.round(rollOnValue(300, 2, '200', 'modernized'))).toBe(239);
  });

  it('is what makes the lone 1 beat the 1 and three 2s early, and lose to it late', () => {
    // Fresh table: 100 in hand and five dice to roll beats banking 300.
    expect(rollOnValue(100, 5, '200', 'modernized')).toBeGreaterThan(300);
    // With 1000 already banked, 1100 and five dice no longer beats banking 1300.
    expect(rollOnValue(1100, 5, '200', 'modernized')).toBeLessThan(1300);
  });

  it('is never below the one-roll plan and never falls as the bank grows', () => {
    const rand = lcg(11);
    const cards: (CardType | null)[] = ['200', '400', '600', 'x2', null];
    const BANK_STEP = 50;
    for (let trial = 0; trial < 200; trial++) {
      const bank = Math.floor(rand() * 40) * BANK_STEP;
      const dice = 1 + Math.floor(rand() * TOTAL_DICE);
      const card = cards[Math.floor(rand() * cards.length)];
      const value = rollOnValue(bank, dice, card, 'modernized');
      expect(value).toBeGreaterThanOrEqual(onePlyValue(bank, dice, card, [], 'modernized') - 1e-9);
      expect(rollOnValue(bank + BANK_STEP, dice, card, 'modernized')).toBeGreaterThanOrEqual(value - 1e-9);
    }
  });
});

describe('onePlyValue', () => {
  it('is the old one-roll arithmetic: survive, keep the most, bank', () => {
    // One die: (1/3) of (bank + the mean of 100 and 50).
    expect(onePlyValue(300, 1, '200', [], 'modernized')).toBeCloseTo((1 / 3) * (300 + 75), 10);
  });
});

describe('continuationValue', () => {
  it('prices a points card by the roll ahead', () => {
    expect(continuationValue(vctx(), 300, 1, [])).toBe(rollOnValue(300, 1, '200', 'modernized'));
  });

  it('prices Plus/Minus and Kniffel by finishing, award included, dice points never', () => {
    expect(continuationValue(vctx({ card: 'Plus_Minus' }), 100, 2, []))
      .toBeCloseTo(completionProbability(2, 'Plus_Minus', [], 'modernized') * (100 + PLUS_MINUS_SCORE), 10);
    expect(continuationValue(vctx({ card: 'Kniffel' }), 0, 1, [1, 2, 3, 4, 5]))
      .toBeCloseTo((1 / 6) * KNIFFEL_SCORE, 10);
  });

  it('prices a Kleeblatt by both tuttos before the first and one after it', () => {
    const p2 = completionProbability(2, 'Kleeblatt', [], 'modernized');
    const p6 = completionProbability(TOTAL_DICE, 'Kleeblatt', [], 'modernized');
    const win = kleeblattWinValue(0, 0, 6000);
    expect(continuationValue(vctx({ card: 'Kleeblatt', tuttosThisTurn: 0 }), 0, 2, [])).toBeCloseTo(p2 * p6 * win, 10);
    expect(continuationValue(vctx({ card: 'Kleeblatt', tuttosThisTurn: 1 }), 0, 2, [])).toBeCloseTo(p2 * win, 10);
  });

  it('still prices Feuerwerk one roll deep', () => {
    expect(continuationValue(vctx({ card: 'Feuerwerk' }), 300, 1, [])).toBe(onePlyValue(300, 1, 'Feuerwerk', [], 'modernized'));
  });
});

describe('tuttoValue', () => {
  it('is the bank itself once a points card or a fixed-award card completes', () => {
    expect(tuttoValue(vctx(), 700)).toBe(700);
    expect(tuttoValue(vctx({ card: 'Plus_Minus' }), 1000)).toBe(1000);
    expect(tuttoValue(vctx({ card: 'Kniffel' }), 2000)).toBe(2000);
  });

  it('is the second tutto\'s odds on the first Kleeblatt tutto and the win on the second', () => {
    const p6 = completionProbability(TOTAL_DICE, 'Kleeblatt', [], 'modernized');
    expect(tuttoValue(vctx({ card: 'Kleeblatt', tuttosThisTurn: 0 }), 0)).toBeCloseTo(p6 * kleeblattWinValue(0, 0, 6000), 10);
    expect(tuttoValue(vctx({ card: 'Kleeblatt', tuttosThisTurn: 1 }), 0)).toBe(kleeblattWinValue(0, 0, 6000));
  });

  it('rolls six fresh dice on a Feuerwerk tutto, since nothing else is offered', () => {
    expect(tuttoValue(vctx({ card: 'Feuerwerk' }), 500)).toBe(continuationValue(vctx({ card: 'Feuerwerk' }), 500, TOTAL_DICE, []));
  });
});

describe('kleeblattWinValue', () => {
  it('is the points still needed to win, never less than the bank at stake, never negative', () => {
    expect(kleeblattWinValue(0, 1000, 6000)).toBe(5000);
    expect(kleeblattWinValue(5500, 1000, 6000)).toBe(5500);
    expect(kleeblattWinValue(0, 7000, 6000)).toBe(0);
  });
});

describe('keepIndices', () => {
  it('maps a keep back onto the table: 1s, then 5s, then whole triples, each in table order', () => {
    expect(keepIndices([1, 2, 2, 2, 3, 4], counts(1, 2, 2, 2))).toEqual([0, 1, 2, 3]);
    expect(keepIndices([1, 2, 2, 2, 3, 4], counts(1))).toEqual([0]);
    expect(keepIndices([5, 3, 5], counts(5))).toEqual([0]);
    expect(keepIndices([2, 2, 2, 5, 1, 3], counts(1, 2, 2, 2, 5))).toEqual([4, 3, 0, 1, 2]);
  });
});
