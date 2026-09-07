import type { CardType, Ruleset } from '../types';
import { checkValidityAndScore, getMaxValidSelection } from './diceLogic';
import { TOTAL_DICE } from './turnShapes';

export interface DescribeLandedRollInput {
  rollVals: number[];
  currentCard: CardType | null;
  kniffelProgress: number[];
  ruleset: Ruleset;
  // Dice already kept on the table before this roll — used only to say
  // whether THIS roll's scoring dice complete the table (a tutto), not to
  // change the roll's own count or score.
  keptCount: number;
}

export interface LandedRollDescription {
  scoringCount: number;
  // null for a card whose dice carry no value of their own — mirrors
  // DiceGame's FIXED_CARD_AWARD/countsDicePoints: Kniffel's dice score 0 by
  // construction (checkValidityAndScore, diceLogic.ts:119-124, a phantom
  // number rather than the card's real award) and Plus/Minus discards its
  // dice outright.
  score: number | null;
  completesTutto: boolean;
}

const FIXED_SCORE_CARDS: ReadonlySet<CardType> = new Set(['Kniffel', 'Plus_Minus']);

/**
 * Describes what a just-landed roll is worth, for the screen-reader
 * announcement (useRollAnnouncement.ts) — never called for a busting roll,
 * whose alert banner speaks instead, but safe on one all the same (score 0,
 * count 0, no throw).
 */
export const describeLandedRoll = ({
  rollVals, currentCard, kniffelProgress, ruleset, keptCount,
}: DescribeLandedRollInput): LandedRollDescription => {
  const scoringIndices = getMaxValidSelection(rollVals, currentCard, kniffelProgress, ruleset);
  const scoringCount = scoringIndices.length;
  const completesTutto = keptCount + scoringCount === TOTAL_DICE;

  if (currentCard !== null && FIXED_SCORE_CARDS.has(currentCard)) {
    return { scoringCount, score: null, completesTutto };
  }

  const scoringVals = scoringIndices.map(i => rollVals[i]);
  const { score } = checkValidityAndScore(scoringVals, currentCard, kniffelProgress, ruleset);
  return { scoringCount, score, completesTutto };
};
