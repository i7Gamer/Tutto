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
