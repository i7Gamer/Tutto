import type { BotPersonality, CardType, Ruleset } from '../types';
import { applyTuttoBonus, checkValidityAndScore, getMaxValidSelection } from './diceLogic';
import { fixedCardAward } from './coreGameEngine';
import { deriveTurnControls } from './diceTurnControls';
import { afterCardCompletion, bankOutcome, canReachNonLosingDraw, canReachNonLosingRoll, hasClassicDraw, type EndgameStandings } from './botEndgame';
import { TOTAL_DICE } from './turnShapes';
import {
  completionProbability, continuationValue, countsToVals, diceCounts, drawValue, keepIndices, legalKeeps, outcomeSpace, tableOutcomes, tuttoValue,
  type DeckCounts, type Keep, type ValueContext,
} from './turnValue';

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
  endgame?: EndgameStandings;
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
  /** Tuttos already rolled this turn — a Kleeblatt's first has the second still to come. */
  tuttosThisTurn: number;
  /** Relative next-card weights (turnValue.nextDrawWeights), using counts and revealed cards. */
  deck: DeckCounts;
  myScore: number;
  leaderScore: number;
  winningScore: number;
  endgame?: EndgameStandings;
  plusMinusScores?: readonly number[];
  canDraw?: boolean;
  chainCardCount?: number;
}

/** Cautious Carl banks the moment a turn is worth this much... */
export const CAUTIOUS_BANK_MIN = 300;
/** ...and never rolls fewer dice than this. */
export const CAUTIOUS_MIN_DICE_TO_ROLL = 3;
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

/**
 * Exact odds of rolling `numDice` under the card's own bust and scoring rules:
 * every multiset the dice can land as is judged with the same helpers the
 * table uses (turnValue's tableOutcomes, memoised per dice, card, progress
 * and rules), so a Kniffel run or a Feuerwerk keep is judged as the game
 * judges it. The bust odds are what the coach prints; the gain is the
 * one-roll plan's mean, kept for Feuerwerk and for the tests that pin it.
 */
export const evaluateRoll = (
  numDice: number,
  card: CardType | null,
  kniffelProgress: number[],
  ruleset: Ruleset,
): RollEvaluation => {
  let busts = 0;
  let gainSum = 0;
  for (const { multiplicity, bust, maxKeepScore } of tableOutcomes(numDice, card, kniffelProgress, ruleset)) {
    if (bust) busts += multiplicity;
    else gainSum += multiplicity * maxKeepScore;
  }
  const outcomes = outcomeSpace(numDice);
  const survivors = outcomes - busts;
  return {
    bustProbability: busts / outcomes,
    expectedGain: survivors === 0 ? 0 : gainSum / survivors,
  };
};

const maxKeep = (ctx: BotTurnContext): number[] =>
  getMaxValidSelection(ctx.rollVals, ctx.currentCard, ctx.kniffelProgress, ctx.ruleset);

const valueContext = (ctx: BotTurnContext): ValueContext => ({
  card: ctx.currentCard,
  ruleset: ctx.ruleset,
  myScore: ctx.myScore,
  winningScore: ctx.winningScore,
  tuttosThisTurn: ctx.tuttosThisTurn,
  // Only classic offers a draw after a tutto; modernized ends the turn there.
  chain: hasClassicDraw(ctx) ? { deck: ctx.deck, myScore: ctx.myScore, winningScore: ctx.winningScore } : undefined,
});

/**
 * How far below the sure bank Otto accepts a gamble: 0 when level with or
 * ahead of the leader, growing with the deficit as a share of the winning
 * score, capped at OPTIMAL_MAX_RISK_APPETITE.
 */
const riskAppetite = (ctx: BotTurnContext): number => {
  const deficit = ctx.winningScore > 0 ? (ctx.leaderScore - ctx.myScore) / ctx.winningScore : 0;
  return Math.min(OPTIMAL_MAX_RISK_APPETITE, Math.max(0, deficit));
};

/**
 * Two keeps whose values differ by less than this are the same keep to Otto
 * (symmetric keeps land a few ulps apart), and the one with more dice wins —
 * what he always did, and the easier of the two to explain.
 */
const VALUE_TIE_EPSILON = 1e-9;
const CERTAIN_COMPLETION = 1;

/**
 * Otto's keep: of every valid selection of the table, the one the rest of the
 * turn is worth most with under the action he will actually choose. Classic
 * Kniffel and Kleeblatt compare completion odds, independent of dice points.
 */
const bestKeep = (ctx: BotTurnContext): number[] => {
  if ((ctx.currentCard === 'Kniffel' && ctx.ruleset !== 'classic') || (ctx.currentCard === 'Feuerwerk' && ctx.ruleset === 'classic')) return maxKeep(ctx);
  let best: { worth: number; priority: number; keep: Keep } | null = null;
  for (const keep of legalKeeps(diceCounts(ctx.rollVals), ctx.currentCard, ctx.kniffelProgress, ctx.ruleset)) {
    const outcome = outcomeOfPicked(ctx, countsToVals(keep.counts));
    const { diceAfter, progressAfter } = outcome;
    const isTutto = ctx.keptCount + keep.dice === TOTAL_DICE;
    // Kleeblatt's dice points never count toward its win. Rank its keeps by
    // completion odds directly, including when the win-value heuristic is
    // zero or the accumulated dice score exceeds the remaining score gap.
    const decision = decisionForKeep(ctx, outcome, isTutto, actionsForKeep(ctx, isTutto));
    const worth = ctx.currentCard === 'Kleeblatt' || ctx.currentCard === 'Kniffel'
      ? isTutto ? CERTAIN_COMPLETION : completionProbability(diceAfter, ctx.currentCard, progressAfter, ctx.ruleset)
      : decision.worth;
    if (!best || decision.priority > best.priority || (decision.priority === best.priority && (worth > best.worth + VALUE_TIE_EPSILON
      || (Math.abs(worth - best.worth) <= VALUE_TIE_EPSILON && keep.dice > best.keep.dice)))) {
      best = { worth, priority: decision.priority, keep };
    }
  }
  return best ? keepIndices(ctx.rollVals, best.keep.counts) : [];
};

/**
 * Carl and Rita keep every scoring die the rules allow; Otto keeps what the
 * rest of the turn is worth most with (bestKeep), which early in a turn is
 * often fewer dice than he could.
 */
export const chooseBotSelection = (ctx: BotTurnContext): number[] =>
  ctx.personality === 'optimal' ? bestKeep(ctx) : maxKeep(ctx);

interface SelectionOutcome {
  /** The turn total if the selection is banked now, tutto bonus and any fixed card award included. */
  bank: number;
  /** Dice on the next table if the bot rolls on. */
  diceAfter: number;
  /** The straight as it will read after this selection — [] once the card completes (a tutto) or for any non-Kniffel card. */
  progressAfter: number[];
}

/**
 * What keeping exactly `picked` (die values) is worth if it is banked now and
 * what rolling on would leave on the table — the two numbers every
 * roll-or-stop and draw-or-stop comparison is built from, and what bestKeep
 * ranks each candidate keep by.
 */
const outcomeOfPicked = (ctx: BotTurnContext, picked: number[]): SelectionOutcome => {
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

/**
 * outcomeOfPicked for the selection chooseBotSelection makes on this table.
 * Exported so the coach hint can show a human the same arithmetic Otto
 * decides with (coachHint.ts), not a second guess at it.
 */
export const outcomeOfSelection = (ctx: BotTurnContext): SelectionOutcome =>
  outcomeOfPicked(ctx, chooseBotSelection(ctx).map(i => ctx.rollVals[i]));

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
  /** What rolling on is worth under best play for the rest of the turn (turnValue.continuationValue). */
  rollValue: number;
  /** The bank, discounted by `appetite` — what rollValue is measured against. */
  threshold: number;
  /** 0 when level with or ahead of the leader; grows with the deficit, capped at OPTIMAL_MAX_RISK_APPETITE. */
  appetite: number;
  action: 'roll' | 'stop';
}

/**
 * Otto's roll-or-stop arithmetic, standalone: not raw value-vs-bank, but the
 * value of rolling on against a bank discounted by a "trailing" appetite
 * that grows with the gap to the leader. The appetite is Otto's character
 * and stays out of the value function. Each keep is ranked by the objective
 * value of the action this comparison selects. Endgame priorities are applied
 * separately by decisionForKeep; the coach uses this arithmetic only when
 * that comparison explains the final decision.
 *
 * `progressAfter` is the straight as THIS selection leaves it (outcomeOfSelection's
 * own return value), not `ctx.kniffelProgress` — the odds of the roll that
 * follows depend on what is collected once the current dice are kept, not on
 * what was collected before them (S-2: only classic Kniffel's odds actually
 * move with this, since modernized Kniffel always needs exactly one value).
 */
export const optimalRollDecision = (ctx: BotTurnContext, bank: number, diceAfter: number, progressAfter: number[]): OptimalRollDecision => {
  const { bustProbability } = evaluateRoll(diceAfter, ctx.currentCard, progressAfter, ctx.ruleset);
  const rollValue = continuationValue(valueContext(ctx), bank, diceAfter, progressAfter);
  const appetite = riskAppetite(ctx);
  const threshold = bank * (1 - appetite);
  return { bustProbability, rollValue, threshold, appetite, action: rollValue >= threshold ? 'roll' : 'stop' };
};

/** What Optimal Otto's draw-or-bank comparison on a classic tutto found, and the numbers behind it. */
export interface OptimalDrawDecision {
  /** What drawing the next card is worth with the bank at stake (turnValue.drawValue). */
  drawValue: number;
  /** The bank, discounted by the same trailing appetite the roll uses. */
  threshold: number;
  appetite: number;
  action: 'draw' | 'stop';
}

/**
 * Otto's draw-or-bank arithmetic on a classic tutto: the draw priced
 * against the deck it comes from (turnValue.drawValue) and measured against
 * the bank the same way a roll is. Banks when no card can come — the store
 * would refuse the draw and bank anyway.
 */
export const optimalDrawDecision = (ctx: BotTurnContext, bank: number): OptimalDrawDecision => {
  const appetite = riskAppetite(ctx);
  const threshold = bank * (1 - appetite);
  const chain = { deck: ctx.deck, myScore: ctx.myScore, winningScore: ctx.winningScore };
  const worth = drawValue(chain, bank, ctx.ruleset);
  const anyCard = Object.values(ctx.deck).some(count => (count ?? 0) > 0);
  return { drawValue: worth, threshold, appetite, action: anyCard && worth >= threshold ? 'draw' : 'stop' };
};

const FORCED_LOSS_PRIORITY = 0;
const ORDINARY_PRIORITY = 1;
const WIN_PRIORITY = 2;

export interface OptimalActionDecision {
  action: BotAction | null;
  reason?: 'bankWin' | 'avoidLoss';
  worth: number;
  priority: number;
}

const actionsForKeep = (ctx: BotTurnContext, isTutto: boolean): BotActionAvailability => {
  const controls = deriveTurnControls({ currentCard: ctx.currentCard, hasRolled: true, bustState: false,
    isMakingTutto: isTutto, tuttosThisTurn: ctx.tuttosThisTurn });
  return { roll: controls.isRollAgainApplicable, stop: controls.canStop, draw: isTutto && hasClassicDraw(ctx) };
};

/** Resolves an evaluated keep without calling selection again. */
const decisionForKeep = (
  ctx: BotTurnContext, outcome: SelectionOutcome, isTutto: boolean, available: BotActionAvailability,
): OptimalActionDecision => {
  const { bank, diceAfter, progressAfter } = outcome;
  const roll = available.roll ? optimalRollDecision(ctx, bank, diceAfter, progressAfter) : null;
  const draw = available.draw ? optimalDrawDecision(ctx, bank) : null;
  let action = available.stop && roll ? roll.action
    : available.stop && draw ? draw.action
      : firstOffered(available, ['roll', 'stop', 'draw']);
  let reason: OptimalActionDecision['reason'];
  let priority = ORDINARY_PRIORITY;
  // Kleeblatt's Stop advances/completes its win condition; it never banks dice points.
  if (ctx.currentCard !== 'Kleeblatt' && ctx.endgame) {
    const completed = isTutto ? afterCardCompletion(ctx, ctx.turnScore) : ctx;
    const settlement = available.stop ? bankOutcome(completed, bank) : null;
    if (settlement === 'win') {
      action = 'stop';
      reason = 'bankWin';
      priority = WIN_PRIORITY;
    } else {
      const usefulRoll = available.roll && canReachNonLosingRoll(ctx, bank, diceAfter);
      const usefulDraw = available.draw && canReachNonLosingDraw(completed, bank);
      if (settlement === 'loss' && (usefulRoll || usefulDraw)) {
        action = usefulRoll ? 'roll' : 'draw';
        reason = 'avoidLoss';
      } else if (settlement === 'loss' || (settlement === null && !usefulRoll && !usefulDraw)) {
        priority = FORCED_LOSS_PRIORITY;
      }
    }
  }
  const worth = action === 'roll' ? roll?.rollValue ?? 0
    : action === 'draw' ? draw?.drawValue ?? 0
      : action === 'stop' ? ctx.currentCard === 'Kleeblatt' ? tuttoValue(valueContext(ctx), bank) : bank : 0;
  return { action, reason, priority, worth };
};

/** The same candidate decision used by keep selection, the bot, and the coach. */
export const optimalActionDecision = (ctx: BotTurnContext, available: BotActionAvailability): OptimalActionDecision => {
  const selected = chooseBotSelection(ctx);
  return decisionForKeep(ctx, outcomeOfPicked(ctx, selected.map(i => ctx.rollVals[i])),
    ctx.keptCount + selected.length === TOTAL_DICE, available);
};

const optimal = (ctx: BotTurnContext, available: BotActionAvailability): BotAction | null =>
  optimalActionDecision(ctx, available).action;

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
