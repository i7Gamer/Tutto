import type { CardType } from '../types';

export const VALID_CARD_TYPES: readonly CardType[] = [
  'Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2',
  '200', '300', '400', '500', '600',
];
export const MAX_CARD_COUNT = 99;

export const isValidWinningScore = (v: unknown): v is number =>
  typeof v === 'number' && v >= 1000 && v <= 99999;

export const isValidTurnDuration = (v: unknown): v is number =>
  typeof v === 'number' && (v === 0 || (v >= 10 && v <= 600));

export const isValidReconnectTimeout = (v: unknown): v is number =>
  typeof v === 'number' && (v === 0 || (v >= 10 && v <= 3600));

export const isValidCardEntry = (key: string, val: unknown): val is number =>
  (VALID_CARD_TYPES as readonly string[]).includes(key) &&
  Number.isInteger(val) && (val as number) >= 0 && (val as number) <= MAX_CARD_COUNT;
