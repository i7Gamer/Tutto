import type { CardType, Die, Ruleset } from '../types';
import { DEFAULT_RULESET } from './configValidation';
import { getMaxValidSelection } from './diceLogic';

export const SPECIAL_CARDS: readonly CardType[] = ['Kniffel', 'Plus_Minus', 'Kleeblatt'];

export const isSpecialCard = (card: CardType | null): boolean =>
  card !== null && (SPECIAL_CARDS as readonly string[]).includes(card);

// Whether the turn ends with a score being entered, as opposed to the yes/no
// answer the special cards take or Stop's no turn at all. Asked by the
// controls to decide what to render and by Game.tsx to decide what the
// primary-action key does — one answer, so the key can't fire something the
// player isn't being shown.
export const hasScoreInput = (card: CardType | null): boolean =>
  !isSpecialCard(card) && card !== 'Stop';

export interface StopButtonText {
  key: string;
  fallback: string;
}

export interface TurnControls {
  isSpecialCard: boolean;
  canStop: boolean;
  isRollAgainApplicable: boolean;
  stopButtonText: StopButtonText;
}

interface DeriveTurnControlsInput {
  currentCard: CardType | null;
  hasRolled: boolean;
  bustState: boolean;
  isMakingTutto: boolean;
  tuttosThisTurn: number;
}

export const deriveTurnControls = ({
  currentCard,
  hasRolled,
  bustState,
  isMakingTutto,
  tuttosThisTurn,
}: DeriveTurnControlsInput): TurnControls => {
  const special = isSpecialCard(currentCard);

  // Selection validity and the mid-roll animation flag are deliberately
  // excluded here: both change transiently (every die click, every reroll)
  // and folding either into this mount decision would pop the button in/out
  // (a visible layout jump as the sibling Roll Again button resizes). The
  // component disables the button via validation.valid / isRolling instead,
  // the same way it already does for Roll Again.
  const canStop =
    hasRolled && !bustState &&
    currentCard !== 'Feuerwerk' && (isMakingTutto || !special);

  const isRollAgainApplicable = !(isMakingTutto && currentCard !== 'Feuerwerk');

  let stopButtonText: StopButtonText = { key: 'dice.stop_and_score', fallback: 'Stop & Score' };
  if (isMakingTutto && special) {
    if (currentCard === 'Kleeblatt' && tuttosThisTurn === 0) {
      stopButtonText = { key: 'dice.roll_2nd_tutto', fallback: 'Roll 2nd Tutto' };
    } else {
      stopButtonText = { key: 'dice.finish_card', fallback: 'Finish Card' };
    }
  }

  return { isSpecialCard: special, canStop, isRollAgainApplicable, stopButtonText };
};

/**
 * Official Feuerwerk keeps EVERY scoring die — the selection is forced, and
 * toggleDie is a no-op for that card, so the board is only playable once this
 * has been applied. Shared by the live roll (DiceGame's finalizeRoll) and the
 * restore of a roll that was cached before finalizeRoll ever ran
 * (deriveRestoredTurn).
 */
export const withForcedFeuerwerkSelection = (roll: Die[], ruleset: Ruleset): Die[] => {
  const forced = new Set(getMaxValidSelection(roll.map(d => d.val), 'Feuerwerk', [], ruleset));
  return roll.map((d, i) => ({ ...d, selected: forced.has(i) }));
};

export const sortKeptDiceForDisplay = (
  keptDice: Die[],
  currentCard: CardType | null,
  kniffelProgress: number[],
  ruleset: Ruleset = DEFAULT_RULESET,
): Die[] => {
  const dice = [...keptDice];
  if (currentCard === 'Kniffel') {
    if (ruleset === 'classic') {
      // Classic collects numbers in any order — the run-direction heuristic
      // below would sort descending whenever the first kept die isn't a 1.
      dice.sort((a, b) => a.val - b.val);
    } else if (kniffelProgress.length > 0) {
      dice.sort((a, b) => (kniffelProgress[0] === 1 ? a.val - b.val : b.val - a.val));
    }
  }
  return dice;
};
