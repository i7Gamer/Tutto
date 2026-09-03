import { localStore } from '../utils/storage';
import type { StoreApi } from 'zustand';
import {
  isValidWinningScore, isValidTurnDuration, isValidReconnectTimeout, isValidCardEntry,
  isValidEnforcedDiceMode, isValidRuleset, VALID_CARD_TYPES, MAX_CARD_COUNT,
} from '../utils/configValidation';
import { MAX_HISTORY_LOG_SIZE, MAX_CHAIN_CARDS } from '../types';
import { PLAYER_NUMERIC_FIELDS } from '../utils/playerStats';
import { MS_PER_SECOND } from '../utils/time';
import { isChainCard, isChainCounter, isChainScoreList, isDeductedAmountList, isTurnCardList, isTurnEnd } from '../utils/turnShapes';
import { roomPhase } from '../utils/roomPhase';
import type { CardType, InitialCards, AssertNever, SyncedGameStateKey } from '../types';
import type { GameStore, GameMode, GameStatus, ConfigKeys } from './storeTypes';

// Fields that make up a saved local game (see attachPersistence's local
// subscriber below, which writes exactly these plus gameTimeInSeconds).
// Shared with pickLocalGameState so the read and write sides can never drift,
// and so a corrupted/hand-edited save can only ever set these known fields —
// not, say, an action name like `startGame`, silently clobbering it with
// whatever value the save file happened to hold.
// previousWasBust/previousHighestTurnScore are needed alongside previousCard
// to revert bust counters and restore highestTurnScore; previousPlayerName is
// needed because calculateUndo looks the previous-turn player up by name (see
// types.ts) — without all three, undo would stay listed as available after a
// reload (previousCard is saved) but either corrupt stats or refuse to undo.
// diceMode is deliberately absent: it is a per-DEVICE input preference, not
// game state, and it already has its own key (tutto_diceMode) that init()
// applies after this save. Carrying it here too meant setMode('local') — which
// never re-reads that key — restored whatever mode the last local game was
// saved under, silently reverting a choice made while online.
const STABLE_LOCAL_GAME_KEYS = [
  'players', 'currentPlayerIndex', 'currentCard', 'cards', 'round',
  'winningScore', 'initialCards', 'randomOrder',
  'turnDuration', 'reconnectTimeout', 'ruleset', 'finished',
  'previousScore', 'previousCard', 'previousLeaders',
  'previousWasBust', 'previousWasSuccess',
  'previousHighestTurnScore', 'previousHighestFeuerwerkTurnScore',
  'previousHighestX2TurnScore', 'previousPlayerName', 'previousTurnSummary',
  'chartValues', 'chartNames', 'chartLabels', 'status', 'historyLog',
] as const satisfies readonly (keyof GameStore)[];

const LOCAL_GAME_STATE_KEYS = [...STABLE_LOCAL_GAME_KEYS, 'gameTimeInSeconds'] as const satisfies readonly (keyof GameStore)[];

// Stamped into every `tutto_local_game` write (see attachPersistence below) and
// checked on read (pickLocalGameState). A save with no schemaVersion at all
// predates this field and is read as version 1 — today's shape — so every
// existing save keeps restoring unchanged. A save whose version is HIGHER than
// this build knows is dropped outright rather than partially restored: a
// future field this code has never validated could be the one a later shape
// change actually depends on for safety. Bump this whenever
// LOCAL_GAME_STATE_KEYS or LOCAL_GAME_VALIDATORS changes in a way that isn't
// backward compatible with an older save.
export const LOCAL_GAME_SCHEMA_VERSION = 1;

// The synced-online fields that deliberately do NOT go into a local save.
// Together with LOCAL_GAME_STATE_KEYS this must account for every canonical
// synced field (SYNCED_GAME_STATE_KEYS, src/types.ts) — a new game-state
// field that is neither saved nor filed here refuses to build, instead of
// silently vanishing from saved local games.
type NeverSavedLocally =
  // The online room's live-dice spectator feed; a local game's running turn
  // persists through its own keys instead (utils/diceTurnState.ts).
  | 'liveTurnState'
  // Per-room host pin, meaningless offline — see the diceMode note above.
  | 'enforcedDiceMode';

// Exported only so noUnusedLocals sees a use; nothing imports it. Each tuple
// element must be `never`, or the build fails naming the offending key.
export type LocalSaveFieldLock = [
  // Every synced field is either saved or deliberately not.
  AssertNever<Exclude<SyncedGameStateKey, (typeof LOCAL_GAME_STATE_KEYS)[number] | NeverSavedLocally>>,
  // Nothing is both.
  AssertNever<Extract<(typeof LOCAL_GAME_STATE_KEYS)[number], NeverSavedLocally>>,
  // And a save holds only game state — a client-only store key here (roomId,
  // isHost, …) would write online-session identity into local saves.
  AssertNever<Exclude<(typeof LOCAL_GAME_STATE_KEYS)[number], SyncedGameStateKey>>,
  // The never-saved list itself holds only real synced fields (typo guard —
  // the same check every other exception list in these locks carries).
  AssertNever<Exclude<NeverSavedLocally, SyncedGameStateKey>>,
];

// A fully-loaded deck holds at most MAX_CARD_COUNT of each card type — same
// bound the server enforces on pushed decks (see server/pushValidation.ts).
const MAX_SAVED_DECK_SIZE = MAX_CARD_COUNT * VALID_CARD_TYPES.length;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isCardOrNull = (v: unknown): boolean =>
  v === null || (VALID_CARD_TYPES as readonly string[]).includes(v as string);
const isCardArray = (v: unknown): boolean =>
  Array.isArray(v) && v.length <= MAX_SAVED_DECK_SIZE &&
  v.every(c => (VALID_CARD_TYPES as readonly string[]).includes(c as string));
const isNonNegativeNumber = (v: unknown): boolean => isFiniteNumber(v) && v >= 0;

// A restored player must have the identity/score fields the engine does
// arithmetic and lookups on; every other present field may only be a
// primitive (stat counters, color, connection flags) — an object or NaN in
// any of them would flow into score math or React rendering downstream.
const isPlausiblePlayer = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== 'string' || p.name.length === 0) return false;
  if (!isFiniteNumber(p.score)) return false;
  // A counter restored as a STRING passed the primitive check below and then
  // met `(p.busts ?? 0) + 1` in the engine, which concatenates: the counter
  // becomes '51' and grows from there, into the end screen and the submitted
  // stats. The per-turn RECORDS fail differently and worse -- they are kept
  // with `x > best` and '99999' > 1500 is a STRING comparison, so a corrupt
  // save pins the record where nothing can ever beat it, and MAX merges it
  // into the device bucket and the global row, where it is permanent.
  // Derived from the two lists that create these fields, so a counter or a
  // record added there is covered here without a third list to remember.
  if (PLAYER_NUMERIC_FIELDS.some(field => p[field] !== undefined && !isFiniteNumber(p[field]))) return false;
  return Object.entries(p).every(([key, val]) =>
    key === 'name' || val === undefined || val === null ||
    typeof val === 'string' || typeof val === 'boolean' || isFiniteNumber(val));
};

// Undo consumes this after a restore: card list, counters and the ended kind
// must all be sane or reversing the turn would corrupt player stats. The
// shapes come from utils/turnShapes.ts, shared with the pushed-state validator
// (server/pushValidation.ts) that checks the very same summary off the wire.
const isPlausibleTurnSummary = (v: unknown): boolean => {
  if (v === null) return true;
  if (typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (!isTurnCardList(s.cards)) return false;
  if (!isChainCounter(s.tuttoCount)) return false;
  if (!isChainScoreList(s.plusMinusScores)) return false;
  if (!isTurnEnd(s.ended)) return false;
  if (s.forfeitedScore !== undefined && !isNonNegativeNumber(s.forfeitedScore)) return false;
  if (s.prevMostCardsInTurn !== undefined && s.prevMostCardsInTurn !== null && !isNonNegativeNumber(s.prevMostCardsInTurn)) return false;
  if (s.prevHighestForfeitedTurnScore !== undefined && s.prevHighestForfeitedTurnScore !== null && !isNonNegativeNumber(s.prevHighestForfeitedTurnScore)) return false;
  if (s.deductedPlayers !== undefined) {
    if (!Array.isArray(s.deductedPlayers) || s.deductedPlayers.length > MAX_CHAIN_CARDS) return false;
    if (!s.deductedPlayers.every(n => typeof n === 'string' && n.length > 0)) return false;
  }
  // Optional: absent on a modernized turn and on any save predating the field.
  // These validators keep an entry whole rather than rebuilding it, so a
  // corrupted save would round-trip straight into summarizeDeductions — which
  // sums the entries by index against deductedPlayers.
  if (s.deductedAmounts !== undefined && !isDeductedAmountList(s.deductedAmounts, s.deductedPlayers)) return false;
  return true;
};

// Display-only, but rendered directly into JSX (HistoryLog.tsx) — a malformed
// entry would crash the render for the restored game.
const isPlausibleHistoryEntry = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) return false;
  const entry = v as Record<string, unknown>;
  // Same optional-but-checked rule as the turn summary's amounts above; this
  // is the entry the activity log renders the numbers from.
  if (entry.deductedAmounts !== undefined && !isDeductedAmountList(entry.deductedAmounts, entry.deductedPlayers)) return false;
  // The two the log reads DIRECTLY and neither of the checks above covers:
  // HistoryLog does `entry.cards.map(getCardName)` for a chain, and iterates
  // deductedPlayers into the deduction summary — and deductedPlayers was only
  // ever looked at as context for deductedAmounts, so an entry carrying it
  // WITHOUT amounts was never validated at all.
  if (entry.cards !== undefined) {
    if (!Array.isArray(entry.cards) || entry.cards.length > MAX_CHAIN_CARDS) return false;
    if (!entry.cards.every(isChainCard)) return false;
  }
  if (entry.deductedPlayers !== undefined) {
    if (!Array.isArray(entry.deductedPlayers) || entry.deductedPlayers.length > MAX_CHAIN_CARDS) return false;
    if (!entry.deductedPlayers.every(n => typeof n === 'string' && n.length > 0)) return false;
  }
  return typeof entry.id === 'string' && typeof entry.playerName === 'string'
    && typeof entry.card === 'string' && typeof entry.type === 'string'
    && Number.isInteger(entry.round) && isFiniteNumber(entry.score);
};

// One shape check per restorable field. A key whose value fails its check is
// dropped — the store keeps its initial default for that field — rather than
// crashing the app downstream wherever the corrupted value is first used.
// Same case-insensitive uniqueness rule the server's joinRoom and
// LocalLobby's handleAddPlayer both enforce at the only points a save is
// normally built — so a well-formed save can never actually hit this. It
// only matters for a hand-edited/corrupted save: duplicate names break
// every name-keyed lookup (Plus/Minus deduction, undo, pushState merging)
// and produce duplicate React keys.
const hasUniquePlayerNames = (players: { name: string }[]): boolean =>
  new Set(players.map(p => p.name.toLowerCase())).size === players.length;

const LOCAL_GAME_VALIDATORS: Record<(typeof LOCAL_GAME_STATE_KEYS)[number], (v: unknown) => boolean> = {
  players: v => Array.isArray(v) && v.every(isPlausiblePlayer) && hasUniquePlayerNames(v),
  currentPlayerIndex: v => v === null || (Number.isInteger(v) && (v as number) >= 0),
  currentCard: isCardOrNull,
  cards: isCardArray,
  round: v => Number.isInteger(v) && (v as number) >= 1,
  winningScore: isValidWinningScore,
  // Every-entry-valid alone is satisfied vacuously by {} and outright by an
  // all-zero deck, and both restore a game with no card to draw: currentCard
  // stays null forever and the game cannot be played. Same rule the server's
  // validateInitialCards has always enforced on the other side.
  initialCards: v => typeof v === 'object' && v !== null &&
    Object.entries(v).length > 0 &&
    Object.entries(v).every(([key, val]) => isValidCardEntry(key, val)) &&
    Object.entries(v).some(([, val]) => (val as number) > 0),
  randomOrder: isBoolean,
  turnDuration: isValidTurnDuration,
  reconnectTimeout: isValidReconnectTimeout,
  // Unlike enforcedDiceMode (meaningless offline, never saved), the ruleset
  // decides how a local game actually plays — dropping it from the save
  // would silently resume a classic game under modernized rules.
  ruleset: isValidRuleset,
  finished: isBoolean,
  previousScore: v => v === null || isFiniteNumber(v),
  previousCard: isCardOrNull,
  previousLeaders: v => v === null || (Array.isArray(v) && v.every(isPlausiblePlayer)),
  previousWasBust: isBoolean,
  // A save predating this field simply has no key here, so the store keeps its
  // default — and calculateUndo cannot tell that apart from a recorded `false`.
  // That is deliberate: it falls back to the score comparison such a save was
  // committed under (see previousWasSuccess in types.ts).
  previousWasSuccess: isBoolean,
  previousHighestTurnScore: isNonNegativeNumber,
  previousHighestFeuerwerkTurnScore: isNonNegativeNumber,
  previousHighestX2TurnScore: isNonNegativeNumber,
  previousPlayerName: v => v === null || (typeof v === 'string' && v.length > 0),
  previousTurnSummary: isPlausibleTurnSummary,
  chartValues: v => Array.isArray(v) && v.every(row => Array.isArray(row) && row.every(isFiniteNumber)),
  chartNames: v => Array.isArray(v) && v.every(name => typeof name === 'string'),
  chartLabels: v => Array.isArray(v) && v.every(isFiniteNumber),
  status: v => v === 'lobby' || v === 'playing',
  historyLog: v => Array.isArray(v) && v.length <= MAX_HISTORY_LOG_SIZE && v.every(isPlausibleHistoryEntry),
  gameTimeInSeconds: isNonNegativeNumber,
};

// Whitelists a parsed `tutto_local_game` value down to known fields AND known
// shapes before it's Object.assign'd into the store — see
// STABLE_LOCAL_GAME_KEYS and LOCAL_GAME_VALIDATORS above. Key-only
// whitelisting used to let a corrupted or hand-edited save put e.g. a string
// where the store expects an array, crashing the app at first use.
export const pickLocalGameState = (parsed: unknown): Partial<GameStore> => {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const source = parsed as Record<string, unknown>;
  // Absent schemaVersion (typeof undefined !== 'number') reads as version 1 —
  // every save written before this field existed. Only a version this build
  // cannot have written (newer than LOCAL_GAME_SCHEMA_VERSION) is rejected;
  // dropping the whole save here rather than field-by-field avoids restoring
  // half of a shape this code was never written to understand.
  if (typeof source.schemaVersion === 'number' && source.schemaVersion > LOCAL_GAME_SCHEMA_VERSION) return {};
  const out: Record<string, unknown> = {};
  for (const key of LOCAL_GAME_STATE_KEYS) {
    if (key in source && LOCAL_GAME_VALIDATORS[key](source[key])) out[key] = source[key];
  }
  // Cross-field sanity: an index is only meaningful against the roster it was
  // saved with. If the players array was dropped (or the index points past
  // it), restoring the index alone would mark a turn as active for a player
  // who does not exist.
  const players = out.players as unknown[] | undefined;
  if (typeof out.currentPlayerIndex === 'number' &&
      (!players || out.currentPlayerIndex >= players.length)) {
    delete out.currentPlayerIndex;
  }
  // chartValues/chartNames are player-indexed (one row per player) — same
  // cross-field rule as the index above. Restoring rows for a roster of a
  // different size would make nextTurn's round-end bookkeeping index
  // players[i] past the end of the roster (a crash) or chart the wrong
  // player. Normal saves always match (startGame sizes the rows from the
  // roster), so this only ever drops hand-edited/corrupted data.
  for (const key of ['chartValues', 'chartNames'] as const) {
    if (key in out && (!players || (out[key] as unknown[]).length !== players.length)) {
      delete out[key];
    }
  }
  return out as Partial<GameStore>;
};

export const validateOnlineConfig = (config: unknown): Partial<Pick<GameStore, ConfigKeys>> => {
  if (typeof config !== 'object' || config === null) return {};
  const valid: Partial<Pick<GameStore, ConfigKeys>> = {};
  const c = config as Record<string, unknown>;
  // Ranges must match the server's applyValidatedConfig (server/pushValidation.ts):
  // values the server would reject are dropped here too, so the lobby never
  // shows a setting the server silently refused.
  if (isValidWinningScore(c.winningScore)) valid.winningScore = c.winningScore;
  if (typeof c.randomOrder === 'boolean') valid.randomOrder = c.randomOrder;
  if (isValidTurnDuration(c.turnDuration)) valid.turnDuration = c.turnDuration;
  if (isValidReconnectTimeout(c.reconnectTimeout)) valid.reconnectTimeout = c.reconnectTimeout;
  // A config saved before this field existed has c.enforcedDiceMode ===
  // undefined, which isValidEnforcedDiceMode correctly rejects (only null or
  // a DiceMode value pass) — so an old save is left with the field absent
  // rather than forced to a value.
  if (isValidEnforcedDiceMode(c.enforcedDiceMode)) valid.enforcedDiceMode = c.enforcedDiceMode;
  // Same old-save rule as enforcedDiceMode: undefined is rejected, leaving
  // the store's default ('modernized') in place rather than forcing a value.
  if (isValidRuleset(c.ruleset)) valid.ruleset = c.ruleset;
  if (typeof c.initialCards === 'object' && c.initialCards !== null) {
    const validCards: InitialCards = {};
    for (const [key, val] of Object.entries(c.initialCards)) {
      if (isValidCardEntry(key, val)) {
        validCards[key as CardType] = val;
      }
    }
    // An all-zero deck leaves currentCard permanently null and the game
    // unplayable — same rule the server enforces in validateInitialCards.
    if (Object.values(validCards).some(count => (count ?? 0) > 0)) valid.initialCards = validCards;
  }
  return valid;
};

// Re-anchor the local game clock after a restore from localStorage. We persist
// elapsed seconds (gameTimeInSeconds), not an absolute start time, so a resumed
// in-progress local game has no live gameStartTime — without this the game timer
// stays frozen at the saved value. Anchoring to "now minus elapsed" lets the clock
// continue from where it left off without counting time the app was closed.
export const reanchorLocalClock = (state: {
  mode: GameMode;
  status: GameStatus;
  finished: boolean;
  currentPlayerIndex: number | null;
  gameTimeInSeconds: number;
  gameStartTime: number | null;
}): void => {
  if (state.mode === 'local' && roomPhase(state) === 'playing' && state.currentPlayerIndex !== null) {
    state.gameStartTime = Date.now() - (state.gameTimeInSeconds || 0) * MS_PER_SECOND;
  }
};

// Wires the localStorage persistence subscribers onto the composed store.
// Called once at module init in useGameStore.ts.
export const attachPersistence = (store: Pick<StoreApi<GameStore>, 'subscribe'>): void => {
  // The 1s game timer mutates gameTimeInSeconds every tick; persisting the whole
  // snapshot on each tick would rewrite localStorage once per second for the entire
  // game. We therefore skip the write unless something other than the timer changed
  // — the current gameTimeInSeconds still rides along whenever a real change is saved.
  let lastLocalPersistKey: string | null = null;
  store.subscribe((state) => {
    if (state.mode !== 'local') {
      lastLocalPersistKey = null; // re-entering local mode should write once
      return;
    }
    // Everything except the per-second timer field forms the "stability key" —
    // built from the same field list pickLocalGameState reads back with, so
    // the two can never drift apart.
    const stable: Record<string, unknown> = {};
    for (const key of STABLE_LOCAL_GAME_KEYS) stable[key] = state[key];
    const persistKey = JSON.stringify(stable);
    if (persistKey === lastLocalPersistKey) return;
    lastLocalPersistKey = persistKey;
    // The latest gameTimeInSeconds still rides along whenever a real change is saved.
    const localStateToSave = {
      ...stable,
      gameTimeInSeconds: state.gameTimeInSeconds,
      schemaVersion: LOCAL_GAME_SCHEMA_VERSION,
    };
    localStore.write('tutto_local_game', JSON.stringify(localStateToSave));
  });

  let lastOnlinePersistKey: string | null = null;
  store.subscribe((state) => {
    if (state.mode !== 'online' || !state.isHost || state.status !== 'lobby') {
      lastOnlinePersistKey = null;
      return;
    }
    // satisfies: this literal is the write half of the saved online config,
    // and it must enumerate exactly the ConfigKeys contract — the read half
    // (validateOnlineConfig above) filters by the same keys, and no test
    // observes this write, so a key dropped here was silently never saved
    // (proven: deleting ruleset left tsc and all 2549 tests green).
    const stable = {
      winningScore: state.winningScore,
      initialCards: state.initialCards,
      randomOrder: state.randomOrder,
      turnDuration: state.turnDuration,
      reconnectTimeout: state.reconnectTimeout,
      enforcedDiceMode: state.enforcedDiceMode,
      ruleset: state.ruleset,
    } satisfies Record<ConfigKeys, unknown>;
    const key = JSON.stringify(stable);
    if (key === lastOnlinePersistKey) return;
    lastOnlinePersistKey = key;
    localStore.write('tutto_online_config', key);
  });
};
