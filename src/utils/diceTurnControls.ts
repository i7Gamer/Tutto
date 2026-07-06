import type { CardType, Die } from '../types';

export const SPECIAL_CARDS: readonly CardType[] = ['Kniffel', 'Plus_Minus', 'Kleeblatt'];

export const isSpecialCard = (card: CardType | null): boolean =>
  card !== null && (SPECIAL_CARDS as readonly string[]).includes(card);

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
  isRolling: boolean;
  bustState: boolean;
  isMakingTutto: boolean;
  tuttosThisTurn: number;
}

export const deriveTurnControls = ({
  currentCard,
  hasRolled,
  isRolling,
  bustState,
  isMakingTutto,
  tuttosThisTurn,
}: DeriveTurnControlsInput): TurnControls => {
  const special = isSpecialCard(currentCard);

  // Selection validity is deliberately excluded here: it changes on every die
  // click, and folding it in would mount/unmount this button on every toggle
  // (a visible layout jump as the sibling Roll Again button resizes). The
  // component disables the button via validation.valid instead, the same way
  // it already does for Roll Again.
  const canStop =
    hasRolled && !isRolling && !bustState &&
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

export const sortKeptDiceForDisplay = (
  keptDice: Die[],
  currentCard: CardType | null,
  kniffelProgress: number[],
): Die[] => {
  const dice = [...keptDice];
  if (currentCard === 'Kniffel' && kniffelProgress.length > 0) {
    dice.sort((a, b) => (kniffelProgress[0] === 1 ? a.val - b.val : b.val - a.val));
  }
  return dice;
};
