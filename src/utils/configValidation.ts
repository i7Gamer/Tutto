import type { CardType, InitialCards, DiceMode } from '../types';

export const VALID_CARD_TYPES: readonly CardType[] = [
  'Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2',
  '200', '300', '400', '500', '600',
];
export const MAX_CARD_COUNT = 99;

// The online path enforces this server-side (socketHandlers.ts joinRoom,
// pushValidation.ts's own MAX_PLAYER_NAME_LENGTH — keep all three in sync).
// LocalLobby has no server round-trip to catch an oversized name, so it
// enforces the same cap client-side before a name ever reaches the store.
export const MAX_PLAYER_NAME_LENGTH = 30;

// Rooms are named by their joiner, so this is a sanity bound rather than a
// format: anything longer is not a room the server would let anyone into.
// Enforced on joinRoom (socketHandlers.ts) and on the client's remembered-room
// cache (recentRooms.ts), which renders stored ids straight into the DOM.
export const MAX_ROOM_ID_LENGTH = 100;

// Shared by every untrusted source of a room id — the remembered-rooms cache
// (recentRooms.ts) and a shared join link (roomLink.ts) — so the two cannot
// drift apart. Both feed the same input and the same joinRoom emit.
export const isPlausibleRoomId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ROOM_ID_LENGTH;

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
// Single source of truth for the default diceMode — used both for a fresh
// store's initial state and whenever a stored preference fails validation
// (see isValidDiceMode) — so "no valid preference" always falls back to the
// same mode everywhere, rather than each call site picking its own default.
export const DEFAULT_DICE_MODE: DiceMode = 'digital';

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
  Number.isInteger(v) && (v as number) >= MIN_WINNING_SCORE && (v as number) <= MAX_WINNING_SCORE;

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

// Key-wise deck equality: two decks are the same iff every card type has the
// same count in both, a missing entry counting as 0. Deliberately not
// JSON.stringify — that comparison is key-ORDER-sensitive, so the same deck
// serialized with another key order would wrongly register as different
// (e.g. a default deck miscounted as "custom" in the global stats).
export const areInitialCardsEqual = (a: InitialCards, b: InitialCards): boolean =>
  VALID_CARD_TYPES.every(card => (a[card] ?? 0) === (b[card] ?? 0));

// null = every player uses their own device's diceMode preference (default);
// a DiceMode value = the host has pinned that mode for every player's own turn.
export const isValidEnforcedDiceMode = (v: unknown): v is DiceMode | null =>
  v === null || v === 'physical' || v === 'digital';

// A per-device preference, unlike enforcedDiceMode above — never null. Used to
// validate a raw localStorage read before trusting it as a DiceMode.
export const isValidDiceMode = (v: unknown): v is DiceMode =>
  v === 'physical' || v === 'digital';
