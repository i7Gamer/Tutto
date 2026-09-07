import type { CardType, Ruleset } from '../types';
import { TOTAL_DICE } from './turnShapes';
import { deriveTurnControls, canDrawAfterTutto } from './diceTurnControls';
import {
  chooseBotSelection, chooseBotAction, outcomeOfSelection, optimalRollDecision,
  type BotAction, type BotActionAvailability, type BotTurnContext,
} from './botStrategies';
import { PERCENT } from './percentage';

export interface CoachHintStandings {
  myScore: number;
  leaderScore: number;
  winningScore: number;
}

export interface CoachHintInput {
  rollVals: number[];
  keptCount: number;
  turnScore: number;
  currentCard: CardType | null;
  ruleset: Ruleset;
  kniffelProgress: number[];
  standings: CoachHintStandings;
  isClassic: boolean;
  // Whether the panel was handed an onDrawCard to ask (DiceGame's own prop) —
  // named for what it decides, not what it is: the coach has no business
  // knowing it is a function.
  canDraw: boolean;
  chainCardCount: number;
  tuttosThisTurn: number;
  // Indices into rollVals the PLAYER currently has toggled on. Read only to
  // decide selectionDiffers — never to decide what is available. See the
  // module comment on coachHint below for why.
  selectedIndices: number[];
  isSelectionLocked: boolean;
}

export interface CoachHint {
  action: BotAction;
  /** The die VALUES Otto would keep, not their indices. */
  keep: number[];
  diceAfter: number;
  bank: number;
  bustPercent: number;
  rollValue: number;
  threshold: number;
  /** True once Otto's appetite for risk has grown above zero (behind the leader). */
  trailing: boolean;
  selectionDiffers: boolean;
}

/**
 * Otto's advice for the roll on the table right now, or null when there is
 * nothing to advise on (a bust table, or nothing offered).
 *
 * Availability is derived from OTTO'S OWN selection, never the player's:
 * DiceGame's own booleans (canStop, isRollAgainApplicable, ...) are all
 * false on a freshly landed roll, because every die lands unselected and an
 * empty selection is invalid there — a hint gated on that would never show
 * at the moment it is promised, the moment the dice settle and before
 * anyone has tapped a thing.
 */
export const coachHint = (input: CoachHintInput): CoachHint | null => {
  const ctx: BotTurnContext = {
    personality: 'optimal',
    rollVals: input.rollVals,
    keptCount: input.keptCount,
    turnScore: input.turnScore,
    currentCard: input.currentCard,
    ruleset: input.ruleset,
    kniffelProgress: input.kniffelProgress,
    myScore: input.standings.myScore,
    leaderScore: input.standings.leaderScore,
    winningScore: input.standings.winningScore,
  };

  const ottoSelection = chooseBotSelection(ctx);
  if (ottoSelection.length === 0) return null;

  const isMakingTutto = input.keptCount + ottoSelection.length === TOTAL_DICE;
  const { canStop, isRollAgainApplicable } = deriveTurnControls({
    currentCard: input.currentCard,
    hasRolled: true,
    bustState: false,
    isMakingTutto,
    tuttosThisTurn: input.tuttosThisTurn,
  });
  const draw = canDrawAfterTutto({
    isClassic: input.isClassic,
    hasDrawCard: input.canDraw,
    isMakingTutto,
    canStop,
    currentCard: input.currentCard,
    chainCardCount: input.chainCardCount,
  });
  const available: BotActionAvailability = { roll: isRollAgainApplicable, stop: canStop, draw };

  const action = chooseBotAction(ctx, available);
  if (!action) return null;

  const { bank, diceAfter } = outcomeOfSelection(ctx);
  const { bustProbability, rollValue, threshold, appetite } = optimalRollDecision(ctx, bank, diceAfter);

  const ottoSet = new Set(ottoSelection);
  const selectionDiffers = input.selectedIndices.length > 0 && !input.isSelectionLocked
    && (input.selectedIndices.length !== ottoSet.size || input.selectedIndices.some(i => !ottoSet.has(i)));

  return {
    action,
    keep: ottoSelection.map(i => input.rollVals[i]),
    diceAfter,
    bank,
    bustPercent: Math.round(bustProbability * PERCENT),
    rollValue,
    threshold,
    trailing: appetite > 0,
    selectionDiffers,
  };
};
