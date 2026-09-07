import type { BotPersonality, CardType, Ruleset } from '../types';
import { applyTuttoBonus, checkValidityAndScore, getMaxValidSelection, isBust } from './diceLogic';
import { fixedCardAward } from './coreGameEngine';
import { DIE_FACES, TOTAL_DICE } from './turnShapes';

/**
 * What a bot decides with, and nothing else: it never drives the turn itself.
 * DiceGame reads the decision and takes the same path a tap would (see
 * useBotDriver there), so every rule, side effect, snapshot and undo path is
 * the one humans use — a second copy of the turn machine would drift on the
 * next rule change.
 */
export type BotAction = 'roll' | 'stop' | 'draw';

/** Which actions the panel's buttons offer right now — the bot picks among these only. */
export interface BotActionAvailability {
  roll: boolean;
  stop: boolean;
  draw: boolean;
}

/** The standings a bot weighs its risk against — what Game hands DiceGame for a bot's seat. */
export interface BotSeat {
  personality: BotPersonality;
  myScore: number;
  leaderScore: number;
  winningScore: number;
}

export interface BotTurnContext {
  personality: BotPersonality;
  /** Every die on the table (not yet kept), in table order. */
  rollVals: number[];
  /** Dice already kept this turn cycle (a tutto resets the count to 0). */
  keptCount: number;
  /** The turn total before this table's selection is added. */
  turnScore: number;
  currentCard: CardType | null;
  ruleset: Ruleset;
  kniffelProgress: number[];
  myScore: number;
  leaderScore: number;
  winningScore: number;
}

/** Cautious Carl banks the moment a turn is worth this much... */
export const CAUTIOUS_BANK_MIN = 300;
/** ...and never rolls fewer dice than this. */
export const CAUTIOUS_MIN_DICE_TO_ROLL = 3;
/** Optimal Otto risks a classic chain on the next card only up to this total. */
export const OPTIMAL_DRAW_BANK_LIMIT = 600;
/**
 * How far below the sure bank Otto will accept a roll's expected value when
 * trailing: the appetite grows with the gap to the leader as a share of the
 * winning score, capped here so a hopeless deficit never turns him into Rita.
 */
const OPTIMAL_MAX_RISK_APPETITE = 0.5;

export interface RollEvaluation {
  bustProbability: number;
  /** Mean score of the best selection over the outcomes that do NOT bust. */
  expectedGain: number;
}

const evaluationCache = new Map<string, RollEvaluation>();

/**
 * Exact odds of rolling `numDice` under the card's own bust and scoring rules:
 * every one of the 6^n outcomes is scored with the same helpers the table
 * uses, so a Kniffel run or a Feuerwerk keep is judged as the game judges
 * it. At most 46 656 outcomes, memoised per (dice, card, progress, rules).
 */
export const evaluateRoll = (
  numDice: number,
  card: CardType | null,
  kniffelProgress: number[],
  ruleset: Ruleset,
): RollEvaluation => {
  if (!Number.isInteger(numDice) || numDice < 1 || numDice > TOTAL_DICE) {
    throw new RangeError(`evaluateRoll: ${numDice} dice is not a table`);
  }
  const key = `${numDice}|${card}|${kniffelProgress.join(',')}|${ruleset}`;
  const cached = evaluationCache.get(key);
  if (cached) return cached;

  const outcomes = DIE_FACES ** numDice;
  let busts = 0;
  let gainSum = 0;
  const vals = new Array<number>(numDice).fill(1);
  for (let outcome = 0; outcome < outcomes; outcome++) {
    let rest = outcome;
    for (let i = 0; i < numDice; i++) {
      vals[i] = (rest % DIE_FACES) + 1;
      rest = Math.floor(rest / DIE_FACES);
    }
    if (isBust(vals, card, kniffelProgress, ruleset)) {
      busts++;
      continue;
    }
    const picked = getMaxValidSelection(vals, card, kniffelProgress, ruleset).map(i => vals[i]);
    gainSum += checkValidityAndScore(picked, card, kniffelProgress, ruleset).score;
  }
  const survivors = outcomes - busts;
  const evaluation = {
    bustProbability: busts / outcomes,
    expectedGain: survivors === 0 ? 0 : gainSum / survivors,
  };
  evaluationCache.set(key, evaluation);
  return evaluation;
};

/** Every personality keeps every scoring die the rules allow. */
export const chooseBotSelection = (ctx: BotTurnContext): number[] =>
  getMaxValidSelection(ctx.rollVals, ctx.currentCard, ctx.kniffelProgress, ctx.ruleset);

interface SelectionOutcome {
  /** The turn total if the selection is banked now, tutto bonus and any fixed card award included. */
  bank: number;
  /** Dice on the next table if the bot rolls on. */
  diceAfter: number;
  /** The straight as it will read after this selection — [] once the card completes (a tutto) or for any non-Kniffel card. */
  progressAfter: number[];
}

/**
 * What a selection is worth if it is banked now and what rolling on would
 * leave on the table — the two numbers every roll-or-stop and draw-or-stop
 * comparison is built from. Exported so the coach hint can show a human the
 * same arithmetic Otto decides with (coachHint.ts), not a second guess at it.
 */
export const outcomeOfSelection = (ctx: BotTurnContext): SelectionOutcome => {
  const picked = chooseBotSelection(ctx).map(i => ctx.rollVals[i]);
  const validation = checkValidityAndScore(picked, ctx.currentCard, ctx.kniffelProgress, ctx.ruleset);
  // A fixed-award card (coreGameEngine.fixedCardAward) pays for completing
  // it, not for the dice it was rolled with — Plus/Minus discards its dice
  // outright and Kniffel scores 0 by construction (checkValidityAndScore
  // above), same as DiceGame's countsDicePoints. The award itself is only
  // earned on the tutto that completes the card.
  const award = fixedCardAward(ctx.currentCard);
  const dicePoints = award > 0 ? 0 : validation.score;
  const isTutto = ctx.keptCount + picked.length === TOTAL_DICE;
  const total = ctx.turnScore + dicePoints + (isTutto ? award : 0);
  return {
    bank: isTutto ? applyTuttoBonus(total, ctx.currentCard) : total,
    diceAfter: isTutto ? TOTAL_DICE : TOTAL_DICE - ctx.keptCount - picked.length,
    progressAfter: isTutto ? [] : validation.newKniffelProgress,
  };
};

const firstOffered = (available: BotActionAvailability, order: BotAction[]): BotAction | null =>
  order.find(action => available[action]) ?? null;

const cautious = (ctx: BotTurnContext, available: BotActionAvailability): BotAction | null => {
  const { bank, diceAfter } = outcomeOfSelection(ctx);
  if (available.stop && (bank >= CAUTIOUS_BANK_MIN || diceAfter < CAUTIOUS_MIN_DICE_TO_ROLL)) return 'stop';
  return firstOffered(available, ['roll', 'stop', 'draw']);
};

const risky = (_ctx: BotTurnContext, available: BotActionAvailability): BotAction | null =>
  firstOffered(available, ['draw', 'roll', 'stop']);

/** What Optimal Otto's roll-or-stop comparison found, and the numbers behind it. */
export interface OptimalRollDecision {
  bustProbability: number;
  expectedGain: number;
  /** The full expected value of rolling on: the bust-adjusted mean of bank + gain. */
  rollValue: number;
  /** The bank, discounted by `appetite` — what rollValue is measured against. */
  threshold: number;
  /** 0 when level with or ahead of the leader; grows with the deficit, capped at OPTIMAL_MAX_RISK_APPETITE. */
  appetite: number;
  action: 'roll' | 'stop';
}

/**
 * Otto's roll-or-stop arithmetic, standalone: not raw EV-vs-bank, but EV
 * against a bank discounted by a "trailing" appetite that grows with the gap
 * to the leader. Exported so the coach hint can show the same comparison
 * `optimal` decides with (coachHint.ts).
 *
 * `progressAfter` is the straight as THIS selection leaves it (outcomeOfSelection's
 * own return value), not `ctx.kniffelProgress` — the odds of the roll that
 * follows depend on what is collected once the current dice are kept, not on
 * what was collected before them (S-2: only classic Kniffel's odds actually
 * move with this, since modernized Kniffel always needs exactly one value).
 */
export const optimalRollDecision = (ctx: BotTurnContext, bank: number, diceAfter: number, progressAfter: number[]): OptimalRollDecision => {
  const { bustProbability, expectedGain } = evaluateRoll(diceAfter, ctx.currentCard, progressAfter, ctx.ruleset);
  const rollValue = (1 - bustProbability) * (bank + expectedGain);
  const deficit = ctx.winningScore > 0 ? (ctx.leaderScore - ctx.myScore) / ctx.winningScore : 0;
  const appetite = Math.min(OPTIMAL_MAX_RISK_APPETITE, Math.max(0, deficit));
  const threshold = bank * (1 - appetite);
  return { bustProbability, expectedGain, rollValue, threshold, appetite, action: rollValue >= threshold ? 'roll' : 'stop' };
};

const optimal = (ctx: BotTurnContext, available: BotActionAvailability): BotAction | null => {
  const { bank, diceAfter, progressAfter } = outcomeOfSelection(ctx);
  if (available.stop && available.roll) {
    return optimalRollDecision(ctx, bank, diceAfter, progressAfter).action;
  }
  if (available.stop && available.draw) {
    return bank <= OPTIMAL_DRAW_BANK_LIMIT ? 'draw' : 'stop';
  }
  return firstOffered(available, ['roll', 'stop', 'draw']);
};

const STRATEGIES: Record<BotPersonality, (ctx: BotTurnContext, available: BotActionAvailability) => BotAction | null> = {
  cautious,
  risky,
  optimal,
};

/**
 * Which of the offered actions the bot takes for the selection
 * chooseBotSelection makes on this table; null when nothing is offered.
 */
export const chooseBotAction = (ctx: BotTurnContext, available: BotActionAvailability): BotAction | null => {
  const action = STRATEGIES[ctx.personality](ctx, available);
  return action && available[action] ? action : null;
};
