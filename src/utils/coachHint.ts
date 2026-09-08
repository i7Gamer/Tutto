import type { CardType, Ruleset } from '../types';
import { TOTAL_DICE } from './turnShapes';
import { deriveTurnControls, canDrawAfterTutto } from './diceTurnControls';
import {
  evaluateOttoDecision,
  type BotAction, type BotActionAvailability, type BotTurnContext,
  type OttoDecisionResult,
} from './botStrategies';
import { PERCENT } from './percentage';
import type { DeckCounts } from './turnValue';

export interface CoachHintStandings {
  myScore: number;
  leaderScore: number;
  winningScore: number;
  endgame?: { opponentScores: readonly number[] };
}

export interface CoachHintInput {
  rollVals: number[];
  keptCount: number;
  turnScore: number;
  currentCard: CardType | null;
  ruleset: Ruleset;
  kniffelProgress: number[];
  standings: CoachHintStandings;
  /** Relative next-card weights from counts and revealed cards (turnValue.nextDrawWeights). */
  deck: DeckCounts;
  // Whether the panel was handed an onDrawCard to ask (DiceGame's own prop) —
  // named for what it decides, not what it is: the coach has no business
  // knowing it is a function.
  canDraw: boolean;
  chainCardCount: number;
  plusMinusScores?: readonly number[];
  tuttosThisTurn: number;
  // Indices into rollVals the PLAYER currently has toggled on. Read only to
  // decide selectionDiffers — never to decide what is available. See the
  // module comment on coachHint below for why.
  selectedIndices: number[];
  isSelectionLocked: boolean;
}

/**
 * What the panel's Stop button would actually DO on this card, which is not
 * always "bank": a Kleeblatt's first tutto rolls the second one, and its
 * second completes the card, which wins the game outright for a turn that
 * scores 0 (resolveKleeblattWin in coreGameEngine). Otto must never advise
 * banking a number that no button on screen can bank.
 */
export type CoachStopMeans = 'bank' | 'secondTutto' | 'winGame';

export interface CoachHint {
  action: BotAction;
  /** The die VALUES Otto would keep, not their indices. */
  keep: number[];
  diceAfter: number;
  bank: number;
  // null unless a roll is actually on offer (available.roll) — never quote a
  // bust risk for a roll the panel is not showing a button for (S-3).
  bustPercent: number | null;
  // Null unless BOTH halves of the comparison are on offer: Kniffel,
  // Plus/Minus and Kleeblatt hold the Stop button back until the card is
  // complete and Feuerwerk never offers it, so on those there is no bank to
  // measure a roll against and no pair of figures to print.
  rollValue: number | null;
  threshold: number | null;
  /** What the Stop button on this table would do. Only read when `action` is 'stop'. */
  stopMeans: CoachStopMeans;
  /**
   * True only on the roll Otto's trailing appetite actually bought: he is
   * behind, rolling on is worth LESS than the bank he could have taken, and
   * he rolls anyway. Anywhere else the clause explains a decision nobody
   * made — worst of all on a stop, where it contradicts the advice.
   */
  trailing: boolean;
  selectionDiffers: boolean;
  reason?: 'bankWin' | 'avoidLoss';
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
export const coachHint = (input: CoachHintInput, evaluated?: OttoDecisionResult): CoachHint | null => {
  // S-5: one spelling of "which ruleset" — derived here instead of carried
  // twice in the input, where nothing reconciled it with `ruleset` itself.
  const isClassic = input.ruleset === 'classic';
  const ctx: BotTurnContext = {
    personality: 'optimal',
    rollVals: input.rollVals,
    keptCount: input.keptCount,
    turnScore: input.turnScore,
    currentCard: input.currentCard,
    ruleset: input.ruleset,
    kniffelProgress: input.kniffelProgress,
    tuttosThisTurn: input.tuttosThisTurn,
    deck: input.deck,
    myScore: input.standings.myScore,
    leaderScore: input.standings.leaderScore,
    winningScore: input.standings.winningScore,
    endgame: input.standings.endgame,
    canDraw: input.canDraw,
    chainCardCount: input.chainCardCount,
    plusMinusScores: input.plusMinusScores,
  };

  const decision = evaluated ?? evaluateOttoDecision(ctx);
  const ottoSelection = decision.selectedIndices;
  if (ottoSelection.length === 0) return null;

  const isMakingTutto = input.keptCount + ottoSelection.length === TOTAL_DICE;
  const { canStop, isRollAgainApplicable, stopButtonText } = deriveTurnControls({
    currentCard: input.currentCard,
    hasRolled: true,
    bustState: false,
    isMakingTutto,
    tuttosThisTurn: input.tuttosThisTurn,
  });
  const draw = canDrawAfterTutto({
    isClassic,
    hasDrawCard: input.canDraw,
    isMakingTutto,
    canStop,
    currentCard: input.currentCard,
    chainCardCount: input.chainCardCount,
  });
  const available: BotActionAvailability = { roll: isRollAgainApplicable, stop: canStop, draw };

  const action = decision.action;
  if (!action) return null;

  const { bank, diceAfter } = decision.outcome;
  const bustProbability = decision.roll?.bustProbability ?? 0;
  const rollValue = decision.roll?.rollValue ?? 0;
  const threshold = decision.roll?.threshold ?? 0;
  const appetite = decision.roll?.appetite ?? decision.draw?.appetite ?? 0;

  const ottoSet = new Set(ottoSelection);
  const selectionDiffers = input.selectedIndices.length > 0 && !input.isSelectionLocked
    && (input.selectedIndices.length !== ottoSet.size || input.selectedIndices.some(i => !ottoSet.has(i)));

  // Otto's own EV arithmetic (appetite included) is computed either way — a
  // roll not being on offer does not change how much risk he is willing to
  // take, only whether the roll figures are a real answer to show (S-3).
  const rollOffered = available.roll;
  // Both figures are one comparison, and it only exists when the player can
  // actually choose between its two sides.
  const comparable = rollOffered && available.stop;
  // The button's own label is the authority on what stopping means here —
  // the same string the panel prints, so the advice and the button can never
  // disagree about the move being advised.
  const stopMeans: CoachStopMeans =
    stopButtonText.key === 'dice.roll_2nd_tutto' ? 'secondTutto'
      : input.currentCard === 'Kleeblatt' ? 'winGame'
        : 'bank';

  return {
    action,
    keep: ottoSelection.map(i => input.rollVals[i]),
    diceAfter,
    bank,
    bustPercent: rollOffered ? Math.round(bustProbability * PERCENT) : null,
    rollValue: !decision.reason && comparable ? rollValue : null,
    threshold: !decision.reason && comparable ? threshold : null,
    stopMeans,
    trailing: !decision.reason && appetite > 0 && action === 'roll' && available.stop && rollValue < bank,
    selectionDiffers,
    reason: decision.reason,
  };
};
