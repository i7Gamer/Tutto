import type { CardType, InitialCards } from '../types';

export const VALID_CARD_TYPES: readonly CardType[] = [
  'Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2',
  '200', '300', '400', '500', '600',
];
export const MAX_CARD_COUNT = 99;

// Single source of truth for the game-config defaults, shared by the client
// store (initial state / reset actions) and the server (new-room state) so the
// two can never drift apart. Consumers that store these in mutable state should
// copy DEFAULT_INITIAL_CARDS (spread) rather than share the object.
export const DEFAULT_INITIAL_CARDS: InitialCards = {
  Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
  x2: 5, '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
};
export const DEFAULT_WINNING_SCORE = 6000;
export const DEFAULT_TURN_DURATION = 120;
export const DEFAULT_RECONNECT_TIMEOUT = 60;

export const isValidWinningScore = (v: unknown): v is number =>
  typeof v === 'number' && v >= 1000 && v <= 99999;

export const isValidTurnDuration = (v: unknown): v is number =>
  typeof v === 'number' && (v === 0 || (v >= 10 && v <= 600));

export const isValidReconnectTimeout = (v: unknown): v is number =>
  typeof v === 'number' && (v === 0 || (v >= 10 && v <= 3600));

export const isValidCardEntry = (key: string, val: unknown): val is number =>
  (VALID_CARD_TYPES as readonly string[]).includes(key) &&
  Number.isInteger(val) && (val as number) >= 0 && (val as number) <= MAX_CARD_COUNT;
