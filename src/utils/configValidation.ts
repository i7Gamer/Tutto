import type { CardType, InitialCards, DiceMode } from '../types';

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

// Accepted ranges, shared by the lobby inputs, the client-side config
// validator and the server (updateConfig / pushState) so a value one layer
// accepts can never be silently rejected by another.
export const MIN_WINNING_SCORE = 1000;
export const MAX_WINNING_SCORE = 99999;
// The two timers are "0 = disabled, otherwise at least MIN_ENABLED_* seconds".
export const MIN_ENABLED_TURN_DURATION = 10;
export const MAX_TURN_DURATION = 600;
export const MIN_ENABLED_RECONNECT_TIMEOUT = 10;
export const MAX_RECONNECT_TIMEOUT = 3600;

export const isValidWinningScore = (v: unknown): v is number =>
  typeof v === 'number' && v >= MIN_WINNING_SCORE && v <= MAX_WINNING_SCORE;

export const isValidTurnDuration = (v: unknown): v is number =>
  typeof v === 'number' && (v === 0 || (v >= MIN_ENABLED_TURN_DURATION && v <= MAX_TURN_DURATION));

export const isValidReconnectTimeout = (v: unknown): v is number =>
  typeof v === 'number' && (v === 0 || (v >= MIN_ENABLED_RECONNECT_TIMEOUT && v <= MAX_RECONNECT_TIMEOUT));

// Lobby inputs let the user type any number, but the timers' valid range has a
// hole (1..minEnabled-1 means neither "disabled" nor an accepted duration).
// Typing a small positive number signals wanting the timer on, so snap up to
// the smallest enabled value rather than silently losing the input.
export const snapDisableableDuration = (v: number, minEnabled: number): number =>
  v > 0 && v < minEnabled ? minEnabled : v;

export const isValidCardEntry = (key: string, val: unknown): val is number =>
  (VALID_CARD_TYPES as readonly string[]).includes(key) &&
  Number.isInteger(val) && (val as number) >= 0 && (val as number) <= MAX_CARD_COUNT;

// null = every player uses their own device's diceMode preference (default);
// a DiceMode value = the host has pinned that mode for every player's own turn.
export const isValidEnforcedDiceMode = (v: unknown): v is DiceMode | null =>
  v === null || v === 'physical' || v === 'digital';
