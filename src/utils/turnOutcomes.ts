import { MAX_CHAIN_CARDS, type TurnCardOutcome } from '../types';
import { MAX_SCORE_MAGNITUDE, VALID_CARD_TYPES } from './configValidation';

/** Shape/bounds only; the authoritative transition validates game semantics. */
export const isTurnCardOutcomeList = (value: unknown): value is TurnCardOutcome[] =>
  Array.isArray(value) && value.length <= MAX_CHAIN_CARDS && value.every(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const outcome = entry as Record<string, unknown>;
    return VALID_CARD_TYPES.includes(outcome.card as TurnCardOutcome['card'])
      && [outcome.scoreBefore, outcome.scoreAfter].every(score =>
        Number.isInteger(score) && (score as number) >= 0 && (score as number) <= MAX_SCORE_MAGNITUDE)
      && Number.isInteger(outcome.tuttos) && (outcome.tuttos as number) >= 0
      && (outcome.tuttos as number) <= MAX_CHAIN_CARDS;
  });

export const copyTurnCardOutcomes = (outcomes: readonly TurnCardOutcome[]): TurnCardOutcome[] =>
  outcomes.map(({ card, scoreBefore, scoreAfter, tuttos }) => ({ card, scoreBefore, scoreAfter, tuttos }));

/** Update the current local journal entry at an existing dice-machine edge. */
export const recordCurrentOutcome = (outcomes: TurnCardOutcome[], scoreAfter: number, tuttoDelta = 0): void => {
  const current = outcomes[outcomes.length - 1];
  if (!current) return;
  current.scoreAfter = scoreAfter;
  current.tuttos += tuttoDelta;
};
