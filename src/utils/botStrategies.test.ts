/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  chooseBotSelection, chooseBotAction, evaluateRoll, outcomeOfSelection, optimalRollDecision, optimalDrawDecision,
  CAUTIOUS_BANK_MIN, CAUTIOUS_MIN_DICE_TO_ROLL,
  type BotTurnContext, type BotActionAvailability, type BotAction,
} from './botStrategies';
import { DEFAULT_INITIAL_CARDS } from './configValidation';
import { KNIFFEL_SCORE, PLUS_MINUS_SCORE } from './coreGameEngine';
import { checkValidityAndScore, getMaxValidSelection } from './diceLogic';
import { BOT_PERSONALITIES, type CardType } from '../types';
import { TOTAL_DICE, DIE_FACES } from './turnShapes';
import { nextDrawWeights } from './turnValue';

// A deterministic generator so the property runs are repeatable.
const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const ctx = (overrides: Partial<BotTurnContext> = {}): BotTurnContext => ({
  personality: 'cautious',
  rollVals: [1, 5, 2, 2, 3, 4],
  keptCount: 0,
  turnScore: 0,
  currentCard: '200',
  ruleset: 'modernized',
  kniffelProgress: [],
  tuttosThisTurn: 0,
  deck: DEFAULT_INITIAL_CARDS,
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

  // Otto keeps whatever the REST of the turn is worth most with, not the
  // most dice (feature_plan_otto_full_info.md): early in a turn fewer dice
  // kept means more dice rolled, and the bonus for a tutto is closer.
  describe('Optimal Otto keeps what the whole turn is worth most with', () => {
    const otto = (o: Partial<BotTurnContext> = {}) => ctx({ personality: 'optimal', ...o });

    it('keeps only the 1 beside three 2s on a fresh table', () => {
      // 100 in hand with five dice to roll is worth 369; the 300 for all four
      // dice would be banked on the spot, because two dice are not worth rolling.
      expect(chooseBotSelection(otto({ rollVals: [1, 2, 2, 2, 3, 4] }))).toEqual([0]);
    });

    it('keeps all four once the turn is already worth 1000', () => {
      expect(chooseBotSelection(otto({ rollVals: [1, 2, 2, 2, 3, 4], turnScore: 1000 }))).toEqual([0, 1, 2, 3]);
    });

    it('keeps the lone 1 rather than the 1 and the 5', () => {
      expect(chooseBotSelection(otto({ rollVals: [1, 5, 2, 3, 4, 6] }))).toEqual([0]);
    });

    it('keeps one 5 of two', () => {
      expect(chooseBotSelection(otto({ rollVals: [5, 5, 2, 3, 4, 6] }))).toEqual([0]);
    });

    it('keeps only the 1 on Plus/Minus and Kleeblatt too: five dice reach the tutto more often than two', () => {
      // Finishing is all that counts there, and the odds are not monotone in
      // the dice (turnValue.test.ts): 26.1% from five dice, 25.9% from two,
      // 24.5% from three. The plan's hand reasoning had this the other way
      // round; the value function settled it.
      expect(chooseBotSelection(otto({ currentCard: 'Plus_Minus', rollVals: [1, 2, 2, 2, 3, 4] }))).toEqual([0]);
      expect(chooseBotSelection(otto({ currentCard: 'Kleeblatt', rollVals: [1, 2, 2, 2, 3, 4] }))).toEqual([0]);
    });

    it('keeps a scoring pair whole on Plus/Minus when one die left beats two', () => {
      // Four kept, a 1 and a 5 on the table: both dice make the tutto now.
      expect(chooseBotSelection(otto({ currentCard: 'Plus_Minus', keptCount: 4, rollVals: [1, 5] }))).toEqual([0, 1]);
      // Three kept, 1 5 and a 3: keeping both leaves one die (33%), one leaves two (26%).
      expect(chooseBotSelection(otto({ currentCard: 'Plus_Minus', keptCount: 3, rollVals: [1, 5, 3] }))).toEqual([0, 1]);
    });

    it('builds a Kniffel run like everyone else', () => {
      expect(chooseBotSelection(otto({ currentCard: 'Kniffel', rollVals: [3, 1, 2, 6, 6, 4] }))).toEqual([1, 2, 0, 5]);
    });

    it('keeps only the 1 on a fresh modernized Feuerwerk, where the turn ends only on a bust', () => {
      // 100 and five dice still earning beats 150 and four (610 against 527).
      expect(chooseBotSelection(otto({ currentCard: 'Feuerwerk', rollVals: [1, 5, 2, 3, 4, 6] }))).toEqual([0]);
      // Three kept: the 1 and the 5 together leave one die, which tuttos one time in three.
      expect(chooseBotSelection(otto({ currentCard: 'Feuerwerk', keptCount: 3, rollVals: [1, 5, 3] }))).toEqual([0, 1]);
    });

    it('keeps every scoring die on a classic Feuerwerk, where the keep is forced', () => {
      expect(chooseBotSelection(otto({ currentCard: 'Feuerwerk', ruleset: 'classic', rollVals: [1, 5, 2, 3, 4, 6] }))).toEqual([0, 1]);
    });

    it('only ever keeps a valid subset of what the rules allow', () => {
      const rand = lcg(5);
      const cards: (CardType | null)[] = ['200', '600', 'x2', null, 'Plus_Minus', 'Kleeblatt', 'Feuerwerk', 'Kniffel'];
      for (let trial = 0; trial < 300; trial++) {
        const keptCount = Math.floor(rand() * TOTAL_DICE);
        const rollVals = Array.from({ length: TOTAL_DICE - keptCount }, () => Math.floor(rand() * DIE_FACES) + 1);
        const context = otto({
          rollVals, keptCount, turnScore: Math.floor(rand() * 40) * 50,
          currentCard: cards[Math.floor(rand() * cards.length)],
        });
        const keep = chooseBotSelection(context);
        const allowed = new Set(getMaxValidSelection(rollVals, context.currentCard, [], context.ruleset));
        keep.forEach(i => expect(allowed.has(i)).toBe(true));
        if (keep.length > 0) {
          expect(checkValidityAndScore(keep.map(i => rollVals[i]), context.currentCard, [], context.ruleset).valid).toBe(true);
        } else {
          expect(allowed.size).toBe(0);
        }
      }
    });
  });

  it('Carl and Rita still keep every scoring die', () => {
    expect(chooseBotSelection(ctx({ personality: 'cautious', rollVals: [1, 2, 2, 2, 3, 4] }))).toEqual([0, 1, 2, 3]);
    expect(chooseBotSelection(ctx({ personality: 'risky', rollVals: [1, 2, 2, 2, 3, 4] }))).toEqual([0, 1, 2, 3]);
  });
});

describe('optimalRollDecision against the progress as it will be, not as it was', () => {
  // S-2: only classic Kniffel's odds actually depend on which numbers are
  // already collected (modernized Kniffel always needs exactly one value, so
  // the odds are the same whichever it is). Keeping the fourth number of a
  // classic straight leaves one die that busts unless it shows the fifth —
  // 5/6, not the 4/6 the stale pre-selection progress would report.
  it('judges the next roll against the straight as it will be, not as it was', () => {
    const afterKeepingOneFive = ctx({
      ruleset: 'classic', currentCard: 'Kniffel', kniffelProgress: [1, 2, 3, 4], keptCount: 4, rollVals: [5, 5],
    });
    const { bank, diceAfter, progressAfter } = outcomeOfSelection(afterKeepingOneFive);
    expect(progressAfter).toEqual([1, 2, 3, 4, 5]);
    const decision = optimalRollDecision(afterKeepingOneFive, bank, diceAfter, progressAfter);
    expect(decision.bustProbability).toBeCloseTo(5 / 6, 10);
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

  it('draws a cheap classic tutto into the standard deck and banks a rich one', () => {
    // Six dice all scoring: 1,1,1 (1000) + 5,5,5 (500) plus the card's 200 —
    // ten Stop cards in 56 forfeit that one draw in six, more than any card
    // adds back.
    const rich = otto({ ruleset: 'classic', rollVals: [1, 1, 1, 5, 5, 5] });
    expect(chooseBotAction(rich, STOP_OR_DRAW)).toBe('stop');
    // Five kept on a 200 total, the sixth a 5: 250 plus the card's 200.
    const cheap = otto({ ruleset: 'classic', keptCount: 5, rollVals: [5], turnScore: 200 });
    expect(chooseBotAction(cheap, STOP_OR_DRAW)).toBe('draw');
  });

  it('reads the deck: never into nothing but Stop cards, always into nothing but Feuerwerk', () => {
    const cheap = otto({ ruleset: 'classic', keptCount: 5, rollVals: [5], turnScore: 200, deck: { Stop: 3 } });
    expect(chooseBotAction(cheap, STOP_OR_DRAW)).toBe('stop');
    const rich = otto({ ruleset: 'classic', rollVals: [1, 1, 1, 5, 5, 5], deck: { Feuerwerk: 2 } });
    expect(chooseBotAction(rich, STOP_OR_DRAW)).toBe('draw');
  });

  it('banks when no card can come', () => {
    const cheap = otto({ ruleset: 'classic', keptCount: 5, rollVals: [5], turnScore: 200, deck: {} });
    expect(chooseBotAction(cheap, STOP_OR_DRAW)).toBe('stop');
  });

  it('draws with more appetite when trailing', () => {
    // A bank the standard deck says to keep when level: 1000 + 200.
    const level = otto({ ruleset: 'classic', keptCount: 3, rollVals: [1, 1, 1], turnScore: 200 });
    expect(chooseBotAction(level, STOP_OR_DRAW)).toBe('stop');
    const behind = otto({ ruleset: 'classic', keptCount: 3, rollVals: [1, 1, 1], turnScore: 200, myScore: 0, leaderScore: 3000 });
    expect(chooseBotAction(behind, STOP_OR_DRAW)).toBe('draw');
  });

  it('shows the draw comparison it decides with', () => {
    const cheap = otto({ ruleset: 'classic', keptCount: 5, rollVals: [5], turnScore: 200 });
    const { bank } = outcomeOfSelection(cheap);
    const decision = optimalDrawDecision(cheap, bank);
    expect(decision.drawValue).toBeGreaterThan(bank);
    expect(decision.threshold).toBe(bank);
    expect(decision.action).toBe('draw');
  });

  // S-1: a completed Kniffel/Plus-Minus used to bank as 0 (checkValidityAndScore
  // scores Kniffel dice 0 and Plus/Minus dice are never counted, and neither is
  // a BONUS_CARDS/x2 tutto bonus), so Otto took the stop-or-draw branch with
  // bank 0 and drew again on a straight worth 2000 every time.
  it('counts the card award in the bank of a completing classic Kniffel', () => {
    const done = otto({
      ruleset: 'classic', currentCard: 'Kniffel', kniffelProgress: [1, 2, 3, 4, 5],
      keptCount: 5, rollVals: [6], turnScore: 0,
    });
    expect(outcomeOfSelection(done).bank).toBe(KNIFFEL_SCORE);
    expect(chooseBotAction(done, STOP_OR_DRAW)).toBe('stop');
  });

  it('counts the card award in the bank of a completing classic Plus/Minus', () => {
    const done = otto({
      ruleset: 'classic', currentCard: 'Plus_Minus', rollVals: [1, 1, 1, 5, 5, 5], turnScore: 0,
    });
    expect(outcomeOfSelection(done).bank).toBe(PLUS_MINUS_SCORE);
    expect(chooseBotAction(done, STOP_OR_DRAW)).toBe('stop');
  });

  // T-2: the exact tie of the roll-or-stop branch (rollValue === threshold
  // rolls — the comparison is `>=`). No real dice roll lands this exactly, so
  // this calls optimalRollDecision directly with a hand-built bank and
  // standings. Every number is exact in floating point: one die on a 200
  // card with 400 in hand banks 700 on a 1 (400 + 100 + 200) and 650 on a 5,
  // so rolling is worth (700 + 650) / 6 = 225 — an integer sum over an integer
  // multiplicity, divided once; and a deficit of 700 on a 1600 winning score
  // is an appetite of exactly 7/16, so the threshold is 400 * 9/16 = 225.
  it('rolls at the exact tie (rollValue === threshold)', () => {
    const tied = otto({ myScore: 0, leaderScore: 700, winningScore: 1600 });
    const decision = optimalRollDecision(tied, 400, 1, []);
    expect(decision.rollValue).toBe(225);
    expect(decision.threshold).toBe(225);
    expect(decision.action).toBe('roll');
  });

  it('rolls the last die when the card\'s bonus makes it worth it, which the one-roll view never saw', () => {
    // Four kept on 250 with a 5 and a 3 on the table: keeping the 5 leaves
    // 300 in hand and one die on a 600 card. A 1 banks 300 + 100 + 600, a 5
    // banks 300 + 50 + 600: rolling is worth (1000 + 950) / 6 = 325 against
    // banking 300.
    const worthIt = otto({ currentCard: '600', keptCount: 4, rollVals: [5, 3], turnScore: 250 });
    expect(chooseBotAction(worthIt, ROLL_OR_STOP)).toBe('roll');
    // Fifty more in hand and it is not: 342 against 350.
    const notQuite = otto({ currentCard: '600', keptCount: 4, rollVals: [5, 3], turnScore: 300 });
    expect(chooseBotAction(notQuite, ROLL_OR_STOP)).toBe('stop');
  });
});

describe('Otto review regressions', () => {
  it('banks a tutto when the revealed run guarantees a Stop next', () => {
    const context = ctx({
      personality: 'optimal', ruleset: 'classic', currentCard: '200',
      rollVals: [1], keptCount: 5, turnScore: 200,
      deck: nextDrawWeights(['Stop', '200', '200'], { '200': 5, Stop: 1 }, ['200', '200', '200']),
    });
    expect(outcomeOfSelection(context).bank).toBe(500);
    expect(optimalDrawDecision(context, 500)).toMatchObject({ drawValue: 0, action: 'stop' });
    expect(chooseBotAction(context, STOP_OR_DRAW)).toBe('stop');
  });

  it('maximizes Kleeblatt completion probability regardless of standings or turn points', () => {
    const standings = [0, 5900, 6000, 7000];
    const turnScores = [0, 500, 10000];
    const tuttoCounts = [0, 1];
    const rulesets = ['modernized', 'classic'] as const;
    for (const ruleset of rulesets) {
      for (const myScore of standings) {
        for (const turnScore of turnScores) {
          for (const tuttosThisTurn of tuttoCounts) {
            const context = ctx({
              personality: 'optimal', currentCard: 'Kleeblatt',
              rollVals: [1, 2, 2, 2, 3, 4], ruleset, myScore, turnScore, tuttosThisTurn,
            });
            expect(chooseBotSelection(context)).toEqual([0]);
            // A certain tutto must still beat every partial keep, even when
            // the score threshold has already been reached.
            expect(chooseBotSelection({ ...context, rollVals: [1], keptCount: 5 })).toEqual([0]);
          }
        }
      }
    }
  });
});

describe('every personality', () => {
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
