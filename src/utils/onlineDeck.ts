import type { CardType, InitialCards } from '../types';
import { VALID_CARD_TYPES } from './configValidation';

/** Public multiset only. Stable key order must not encode the private order. */
export const deckComposition = (cards: readonly CardType[]): InitialCards => {
  const counts = new Map<CardType, number>();
  for (const card of cards) counts.set(card, (counts.get(card) ?? 0) + 1);
  return Object.fromEntries(VALID_CARD_TYPES
    .filter(card => counts.has(card))
    .map(card => [card, counts.get(card)!]));
};

/** A canonical bag for display/probability consumers, never a draw source. */
export const compositionCards = (counts: InitialCards | null): CardType[] =>
  VALID_CARD_TYPES.flatMap(card => Array<CardType>(counts?.[card] ?? 0).fill(card));

export const compositionSize = (counts: InitialCards | null): number =>
  VALID_CARD_TYPES.reduce((total, card) => total + (counts?.[card] ?? 0), 0);
