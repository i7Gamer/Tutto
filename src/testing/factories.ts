/**
 * Typed fixture factories for the test suites.
 *
 * `tsconfig.test.json` (read its header) is not yet a type-check gate because
 * the suites are full of partial object literals standing in for full
 * interfaces — a two-field object passed where a `Player` is expected, a
 * ten-field one standing in for a `CoreGameState`. Every factory here builds
 * a COMPLETE, correctly-typed object with sensible defaults, so a test only
 * has to spell out the fields it cares about.
 *
 * Not imported by any application module — same rule as storageStubs.ts.
 */
import type { CoreGameState, DiceSnapshot, Player } from '../types';
import { zeroedPlayerStats } from '../utils/playerStats';
import type { PreGameStats } from '../store/storeTypes';

/**
 * A full `Player`, every counter zeroed (see `zeroedPlayerStats`). Pass
 * `{ name: 'Alice', score: 500, ... }` to override just what the test needs;
 * everything else stays a real, typed default rather than `undefined`.
 */
export const makePlayer = (overrides: Partial<Player> = {}): Player => ({
  name: 'Player',
  ...zeroedPlayerStats(),
  position: 0,
  ...overrides,
});

// `satisfies` rather than a `: CoreGameState` annotation: an annotation would
// widen currentPlayerIndex to the interface's declared `number | null` even
// though this default is the literal `0`. Several engine functions
// (calculateNextTurn) require `CoreGameState & { currentPlayerIndex: number }`
// — keeping the literal type here, and inferring the override type generically
// below, is what lets `makeGameState({ currentPlayerIndex: 1 })` satisfy that
// without a cast at every call site.
// A function, not a shared constant: an array/object field (players, cards,
// historyLog, ...) copied by a plain object spread stays the SAME reference,
// so a shared constant would have every call's state alias one another's
// mutable collections — precisely the hazard configValidation.ts warns about
// for DEFAULT_INITIAL_CARDS. Rebuilding it fresh per call is what keeps each
// makeGameState() its own.
const buildDefaultGameState = () => ({
  players: [makePlayer({ name: 'Alice' }), makePlayer({ name: 'Bob' })],
  currentPlayerIndex: 0,
  currentCard: null,
  round: 1,
  winningScore: 6000,
  cards: [],
  initialCards: {},
  previousCard: null,
  previousScore: null,
  previousLeaders: null,
  previousWasBust: false,
  previousHighestTurnScore: 0,
  previousHighestFeuerwerkTurnScore: 0,
  previousHighestX2TurnScore: 0,
  previousPlayerName: null,
  previousTurnSummary: null,
  finished: false,
  gameStartTime: null,
  gameTimeInSeconds: 0,
  historyLog: [],
} satisfies CoreGameState);

/**
 * A full `CoreGameState` with a sensible two-player default roster. Every
 * field CoreGameState declares is present — including the `previous*`
 * bookkeeping and `historyLog` that hand-rolled test literals routinely
 * dropped, which is exactly what made them fail to type-check as a whole
 * state rather than a fragment of one.
 *
 * Generic over the overrides so a literal like `{ currentPlayerIndex: 1 }`
 * narrows the RETURN type too (`CoreGameState & { currentPlayerIndex: number }`),
 * not just the input — see the comment on DEFAULT_GAME_STATE above.
 */
export const makeGameState = <T extends Partial<CoreGameState> = Record<string, never>>(
  overrides?: T,
): CoreGameState & T => ({
  ...buildDefaultGameState(),
  ...overrides,
}) as CoreGameState & T;

/**
 * A real `Response` (jsdom and node 22 both implement it — no hand-rolled
 * `{ ok, json: () => ... }` stand-in needed) wrapping a JSON body, for
 * `global.fetch = vi.fn(() => Promise.resolve(mockFetchJson(...)))` and
 * friends.
 */
export const mockFetchJson = (body: unknown, init: { ok?: boolean; status?: number } = {}): Response => {
  const status = init.status ?? (init.ok === false ? 500 : 200);
  return new Response(JSON.stringify(body), { status });
};

/**
 * A full `PreGameStats` (the device's personal-best snapshot EndScreen shows
 * next to a fresh record), every field `null` — the same "no record yet"
 * default the real column reads before a device has ever played. Pass
 * `{ highestTurnScore: 1500, ... }` to override just what the test needs.
 */
export const makePreGameStats = (overrides: Partial<PreGameStats> = {}): PreGameStats => ({
  highestTurnScore: null,
  fastestWinTurns: null,
  fastestLossTurns: null,
  highestFeuerwerkTurnScore: null,
  highestX2TurnScore: null,
  mostCardsInTurn: null,
  highestForfeitedTurnScore: null,
  ...overrides,
});

/**
 * A full `DiceSnapshot` (the mid-turn shape stored in `liveTurnState`), every
 * field zeroed/empty. Pass `{ turnScore: 50, keptDice: [...] }` to override
 * just what the test cares about — the same idiom as `makeGameState`.
 */
export const makeDiceSnapshot = (overrides: Partial<DiceSnapshot> = {}): DiceSnapshot => ({
  turnScore: 0,
  keptDice: [],
  currentRoll: [],
  kniffelProgress: [],
  tuttosThisTurn: 0,
  ...overrides,
});

/**
 * Asserts a value that a function typed `T | null | undefined` produced is
 * actually present, and narrows it to `T` for everything after. The runtime
 * check is a real assertion (it throws, same as an unmet `expect`, if the
 * value is missing) — this only replaces a bare non-null assertion so a
 * regression that starts returning null is still caught, not silently cast
 * away.
 */
export const nonNull = <T>(value: T | null | undefined, message = 'Expected a non-null value'): T => {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
};
