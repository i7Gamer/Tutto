import type { CardType } from '../types';

// The icon each card is shown by, in the history log and in the statistics
// card breakdown. One definition per card: the two screens named the same
// cards with their own copies of these before, so a card could be a clover in
// one place and something else in the other.
export const CARD_EMOJIS: Record<CardType, string> = {
  Kleeblatt: '🍀',
  Feuerwerk: '🎆',
  Stop: '🛑',
  Kniffel: '🎲',
  Plus_Minus: '±',
  x2: '✖️',
  '200': '🃏',
  '300': '🃏',
  '400': '🃏',
  '500': '🃏',
  '600': '🃏',
};

// History entries come from the server and from localStorage, so the card
// named in one is not guaranteed to be a card this build knows about.
export const UNKNOWN_CARD_EMOJI = '🎲';

// How the dice panel's header names a card. Cards not listed here read fine
// under their own id (Kleeblatt, Feuerwerk, x2, ...); these are the ones whose
// raw id would be cryptic ('Plus_Minus') or bare ('300').
const CARD_NAME_MAP: Partial<Record<CardType, string>> = {
  'Plus_Minus': 'Plus/Minus',
  '200': '200 Bonus',
  '300': '300 Bonus',
  '400': '400 Bonus',
  '500': '500 Bonus',
  '600': '600 Bonus',
};

export const getDisplayCardName = (cardName: CardType | null): string => {
  if (!cardName) return '';
  return CARD_NAME_MAP[cardName] ?? cardName;
};
