/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  chooseBotSelection, chooseBotAction, evaluateRoll,
  CAUTIOUS_BANK_MIN, CAUTIOUS_MIN_DICE_TO_ROLL, OPTIMAL_DRAW_BANK_LIMIT,
  type BotTurnContext, type BotActionAvailability, type BotAction,
} from './botStrategies';
import { BOT_PERSONALITIES, type CardType } from '../types';
import { TOTAL_DICE, DIE_FACES } from './turnShapes';

const ctx = (overrides: Partial<BotTurnContext> = {}): BotTurnContext => ({
  personality: 'cautious',
  rollVals: [1, 5, 2, 2, 3, 4],
  keptCount: 0,
  turnScore: 0,
  currentCard: '200',
  ruleset: 'modernized',
  kniffelProgress: [],
  myScore: 0,
  leaderScore: 0,
  winningScore: 6000,
  ...overrides,
});

const ALL: BotActionAvailability = { roll: true, stop: true, draw: true };
const ROLL_OR_STOP: BotActionAvailability = { roll: true, stop: true, draw: false };
const STOP_OR_DRAW: BotActionAvailability = { roll: false, stop: true, draw: true };
const ONLY_ROLL: BotActionAvailability = { roll: true, stop: false, draw: false };
const NONE: BotActionAvailability = { roll: false, stop: false, draw: false };

describe('evaluateRoll', () => {
  it('knows the bust odds of a plain scoring card exactly', () => {
    // One die busts unless it is a 1 or a 5.
    expect(evaluateRoll(1, '200', [], 'modernized').bustProbability).toBeCloseTo(4 / 6, 10);
    // Two dice: neither a 1 nor a 5 on either.
    expect(evaluateRoll(2, '200', [], 'modernized').bustProbability).toBeCloseTo(16 / 36, 10);
    // Six dice: 1440 of the 46656 outcomes have no 1, no 5 and no triple.
    expect(evaluateRoll(6, '200', [], 'modernized').bustProbability).toBeCloseTo(1440 / 46656, 10);
  });

  it('averages the best selection over the outcomes that do not bust', () => {
    // A lone die that survives shows a 1 (100) or a 5 (50).
    expect(evaluateRoll(1, '200', [], 'modernized').expectedGain).toBeCloseTo(75, 10);
  });

  it('is card-aware: a fresh classic Kniffel cannot bust and scores nothing per die', () => {
    const fresh = evaluateRoll(6, 'Kniffel', [], 'classic');
    expect(fresh.bustProbability).toBe(0);
    expect(fresh.expectedGain).toBe(0);
    // With every number but the 6 collected, one die busts five times in six.
    expect(evaluateRoll(1, 'Kniffel', [1, 2, 3, 4, 5], 'classic').bustProbability).toBeCloseTo(5 / 6, 10);
  });

  it('never enumerates past the table', () => {
    expect(() => evaluateRoll(TOTAL_DICE + 1, '200', [], 'modernized')).toThrow();
    expect(() => evaluateRoll(0, '200', [], 'modernized')).toThrow();
  });
});

describe('chooseBotSelection', () => {
  it('takes every scoring die the rules allow', () => {
    expect(chooseBotSelection(ctx({ rollVals: [1, 5, 2, 2, 3, 4] }))).toEqual([0, 1]);
    expect(chooseBotSelection(ctx({ rollVals: [2, 2, 2, 3, 4, 6] }))).toEqual([0, 1, 2]);
    expect(chooseBotSelection(ctx({ rollVals: [2, 3, 4, 6, 6, 4] }))).toEqual([]);
  });

  it('follows the card: a modernized Kniffel builds its run', () => {
    expect(chooseBotSelection(ctx({ currentCard: 'Kniffel', rollVals: [3, 1, 2, 6, 6, 4] }))).toEqual([1, 2, 0, 5]);
  });
});

describe('Cautious Carl', () => {
  const carl = (o: Partial<BotTurnContext> = {}) => ctx({ personality: 'cautious', ...o });

  it('rolls on while the bank is small and enough dice remain', () => {
    // 150 banked, four dice left.
    expect(chooseBotAction(carl(), ROLL_OR_STOP)).toBe('roll');
  });

  it('banks as soon as the turn reaches the minimum', () => {
    expect(CAUTIOUS_BANK_MIN).toBe(300);
    expect(chooseBotAction(carl({ turnScore: 150 }), ROLL_OR_STOP)).toBe('stop');
    // Exactly the minimum on the table counts.
    expect(chooseBotAction(carl({ rollVals: [2, 2, 2, 3, 4, 1] }), ROLL_OR_STOP)).toBe('stop');
  });

  it('never rolls two dice or fewer', () => {
    expect(CAUTIOUS_MIN_DICE_TO_ROLL).toBe(3);
    // Four kept, a 1 and a 3 on the table: keeping the 1 leaves one die.
    expect(chooseBotAction(carl({ keptCount: 4, rollVals: [1, 3], turnScore: 50 }), ROLL_OR_STOP)).toBe('stop');
    // Three kept, keeping one leaves two.
    expect(chooseBotAction(carl({ keptCount: 3, rollVals: [1, 3, 4], turnScore: 50 }), ROLL_OR_STOP)).toBe('stop');
    // Two kept, keeping one leaves three: still rolls.
    expect(chooseBotAction(carl({ keptCount: 2, rollVals: [1, 3, 4, 6], turnScore: 50 }), ROLL_OR_STOP)).toBe('roll');
  });

  it('never draws the next card on a classic chain', () => {
    expect(chooseBotAction(carl({ ruleset: 'classic', turnScore: 100 }), STOP_OR_DRAW)).toBe('stop');
    expect(chooseBotAction(carl({ ruleset: 'classic' }), ALL)).not.toBe('draw');
  });

  it('rolls when rolling is all there is (a special card mid-way)', () => {
    expect(chooseBotAction(carl({ currentCard: 'Kniffel', rollVals: [1, 3, 3, 4, 6, 6] }), ONLY_ROLL)).toBe('roll');
  });
});

describe('Risk-Taker Rita', () => {
  const rita = (o: Partial<BotTurnContext> = {}) => ctx({ personality: 'risky', ...o });

  it('keeps rolling however much is on the line', () => {
    expect(chooseBotAction(rita({ turnScore: 5000 }), ROLL_OR_STOP)).toBe('roll');
    expect(chooseBotAction(rita({ keptCount: 5, rollVals: [1], turnScore: 2000 }), ROLL_OR_STOP)).toBe('roll');
  });

  it('draws the next card whenever a classic tutto offers one', () => {
    expect(chooseBotAction(rita({ ruleset: 'classic', turnScore: 3000 }), STOP_OR_DRAW)).toBe('draw');
  });

  it('stops only when stopping is the sole option', () => {
    expect(chooseBotAction(rita(), { roll: false, stop: true, draw: false })).toBe('stop');
  });
});

describe('Optimal Otto', () => {
  const otto = (o: Partial<BotTurnContext> = {}) => ctx({ personality: 'optimal', ...o });

  it('banks when one die is left and the bank outweighs the gamble', () => {
    // Four kept, the 5 makes the bank 350 and leaves one die: rolling it is
    // worth (1/3) * (350 + 75) = 142.
    expect(chooseBotAction(otto({ keptCount: 4, rollVals: [5, 3], turnScore: 300 }), ROLL_OR_STOP)).toBe('stop');
  });

  it('rolls a full table of dice on a small bank', () => {
    // Keeping the lone 1 leaves five dice; the bank is 100.
    expect(chooseBotAction(otto({ rollVals: [1, 2, 3, 4, 6, 6] }), ROLL_OR_STOP)).toBe('roll');
  });

  it('takes more risk the further behind the leader it is', () => {
    // Two dice on a bank of 300: rolling is worth (20/36) * (300 + 90) = 217.
    // Level with the leader that is a stop; half the winning score behind,
    // the same table is worth rolling.
    const level = otto({ keptCount: 3, rollVals: [1, 3, 4], turnScore: 200 });
    expect(chooseBotAction(level, ROLL_OR_STOP)).toBe('stop');
    const behind = otto({ keptCount: 3, rollVals: [1, 3, 4], turnScore: 200, myScore: 0, leaderScore: 3000 });
    expect(chooseBotAction(behind, ROLL_OR_STOP)).toBe('roll');
  });

  it('draws on a classic tutto only while the chain is still cheap to lose', () => {
    expect(OPTIMAL_DRAW_BANK_LIMIT).toBe(600);
    // Six dice all scoring: 1,1,1 (1000) + 5,5,5 (500) is far past the limit.
    const rich = otto({ ruleset: 'classic', rollVals: [1, 1, 1, 5, 5, 5] });
    expect(chooseBotAction(rich, STOP_OR_DRAW)).toBe('stop');
    // Five kept on a 200 total, the sixth a 5: 250 plus the card's 200.
    const cheap = otto({ ruleset: 'classic', keptCount: 5, rollVals: [5], turnScore: 200 });
    expect(chooseBotAction(cheap, STOP_OR_DRAW)).toBe('draw');
  });
});

describe('every personality', () => {
  // A deterministic generator so the property run is repeatable.
  const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  it('only ever picks an action that is on offer, and nothing when none is', () => {
    const rand = lcg(7);
    const cards: (CardType | null)[] = ['200', '300', 'x2', 'Feuerwerk', 'Kniffel', 'Plus_Minus', 'Kleeblatt', null];
    const rulesets = ['modernized', 'classic'] as const;
    for (let trial = 0; trial < 3000; trial++) {
      const keptCount = Math.floor(rand() * TOTAL_DICE);
      const rollVals = Array.from({ length: TOTAL_DICE - keptCount }, () => Math.floor(rand() * DIE_FACES) + 1);
      const context = ctx({
        personality: BOT_PERSONALITIES[Math.floor(rand() * BOT_PERSONALITIES.length)],
        rollVals,
        keptCount,
        turnScore: Math.floor(rand() * 40) * 50,
        currentCard: cards[Math.floor(rand() * cards.length)],
        ruleset: rulesets[Math.floor(rand() * rulesets.length)],
        kniffelProgress: [],
        myScore: Math.floor(rand() * 6000),
        leaderScore: Math.floor(rand() * 6000),
      });
      const available: BotActionAvailability = { roll: rand() < 0.5, stop: rand() < 0.5, draw: rand() < 0.5 };
      const action = chooseBotAction(context, available);
      const offered = (Object.keys(available) as BotAction[]).filter(a => available[a]);
      if (offered.length === 0) {
        expect(action).toBeNull();
      } else {
        expect(offered).toContain(action);
      }
    }
    expect(chooseBotAction(ctx(), NONE)).toBeNull();
  });
});
