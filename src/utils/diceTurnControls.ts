import type { CardType, Die, Ruleset } from '../types';
import { DEFAULT_RULESET, MAX_SCORE_MAGNITUDE } from './configValidation';
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

const SCORE_INPUT_RADIX = 10;
// Nothing a player can enter is worth a negative turn score: the box is a
// number input, but a pasted '-5' (or a browser that lets the minus through)
// would otherwise subtract from the running total.
const MIN_PARSED_SCORE = 0;

/**
 * The number behind whatever is currently in the score box. The box holds a
 * string that is empty before anything is typed and can hold anything a paste
 * puts there, so every reader wants the same four rules: leading digits win
 * ('12abc' is 12, the way the number input's own coercion reads it), anything
 * with no leading digits is 0, the result never goes below zero, and it never
 * exceeds MAX_SCORE_MAGNITUDE — the same ceiling the server enforces on every
 * pushed score, so a value this clamps can never desync the two. Shared by
 * Game.tsx's commit handlers and usePhysicalChain's cache/snapshot writes so
 * the score a turn commits and the score it broadcasts can never disagree.
 */
export const parseScoreInput = (raw: string): number =>
  Math.min(MAX_SCORE_MAGNITUDE, Math.max(MIN_PARSED_SCORE, parseInt(raw, SCORE_INPUT_RADIX) || MIN_PARSED_SCORE));

/**
 * What the score box's own text should become after a keystroke or a
 * quick-add tap, so it can never DISPLAY a number larger than what
 * parseScoreInput would actually commit — typing '9999999' snaps the box
 * back to the clamped value instead of showing nine million right up until
 * Next Turn silently banks one. Empty stays empty (untouched, not "0"); the
 * distinction parseScoreInput's own MIN_PARSED_SCORE floor doesn't need to
 * make, since it only ever reports a committed NUMBER.
 */
export const clampScoreInputText = (raw: string): string =>
  raw === '' ? '' : String(parseScoreInput(raw));

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
