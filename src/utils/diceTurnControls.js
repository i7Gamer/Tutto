// Pure derivations for the DiceGame action controls (which buttons show, what
// the stop button says, how kept dice are ordered). Kept separate from the
// component so the branching across card types and turn states is unit-testable.

// Cards whose turn only resolves on a completed Tutto rather than a free stop.
export const SPECIAL_CARDS = ["Kniffel", "Plus_Minus", "Kleeblatt"];

export const isSpecialCard = (card) => SPECIAL_CARDS.includes(card);

// Decide the state of the Roll Again / Stop controls and the stop button label.
// `stopButtonText` is returned as an i18n { key, fallback } pair so the caller
// owns translation.
export const deriveTurnControls = ({
  currentCard,
  hasRolled,
  isRolling,
  bustState,
  validationValid,
  isMakingTutto,
  tuttosThisTurn,
}) => {
  const special = isSpecialCard(currentCard);

  const canStop =
    hasRolled && !isRolling && !bustState && validationValid &&
    currentCard !== "Feuerwerk" && (isMakingTutto || !special);

  const isRollAgainApplicable = !(isMakingTutto && currentCard !== "Feuerwerk");

  let stopButtonText = { key: 'dice.stop_and_score', fallback: 'Stop & Score' };
  if (isMakingTutto && special) {
    if (currentCard === "Kleeblatt" && tuttosThisTurn === 0) {
      stopButtonText = { key: 'dice.roll_2nd_tutto', fallback: 'Roll 2nd Tutto' };
    } else {
      stopButtonText = { key: 'dice.finish_card', fallback: 'Finish Card' };
    }
  }

  return { isSpecialCard: special, canStop, isRollAgainApplicable, stopButtonText };
};

// Kept dice are shown in the order they were locked in, except for Kniffel where
// they read as the building sequence (ascending from 1, descending from 6).
export const sortKeptDiceForDisplay = (keptDice, currentCard, kniffelProgress) => {
  const dice = [...keptDice];
  if (currentCard === "Kniffel" && kniffelProgress.length > 0) {
    dice.sort((a, b) => (kniffelProgress[0] === 1 ? a.val - b.val : b.val - a.val));
  }
  return dice;
};
