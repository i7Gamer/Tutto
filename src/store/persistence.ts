import type { StoreApi } from 'zustand';
import { isValidWinningScore, isValidTurnDuration, isValidReconnectTimeout, isValidCardEntry, isValidEnforcedDiceMode } from '../utils/configValidation';
import type { CardType, InitialCards } from '../types';
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
const STABLE_LOCAL_GAME_KEYS = [
  'players', 'currentPlayerIndex', 'currentCard', 'cards', 'round',
  'winningScore', 'diceMode', 'initialCards', 'randomOrder',
  'turnDuration', 'reconnectTimeout', 'finished',
  'previousScore', 'previousCard', 'previousLeaders',
  'previousWasBust', 'previousHighestTurnScore', 'previousPlayerName',
  'chartValues', 'chartNames', 'chartLabels', 'status', 'historyLog',
] as const satisfies readonly (keyof GameStore)[];

const LOCAL_GAME_STATE_KEYS = [...STABLE_LOCAL_GAME_KEYS, 'gameTimeInSeconds'] as const satisfies readonly (keyof GameStore)[];

// Whitelists a parsed `tutto_local_game` value down to known fields before
// it's Object.assign'd into the store — see STABLE_LOCAL_GAME_KEYS above.
export const pickLocalGameState = (parsed: unknown): Partial<GameStore> => {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const source = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of LOCAL_GAME_STATE_KEYS) {
    if (key in source) out[key] = source[key];
  }
  return out as Partial<GameStore>;
};

export const validateOnlineConfig = (config: unknown): Partial<Pick<GameStore, ConfigKeys>> => {
  if (typeof config !== 'object' || config === null) return {};
  const valid: Partial<Pick<GameStore, ConfigKeys>> = {};
  const c = config as Record<string, unknown>;
  // Ranges must match the server's applyValidatedConfig (server/index.ts):
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
  if (state.mode === 'local' && state.status === 'playing' && !state.finished && state.currentPlayerIndex !== null) {
    state.gameStartTime = Date.now() - (state.gameTimeInSeconds || 0) * 1000;
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
    const localStateToSave = { ...stable, gameTimeInSeconds: state.gameTimeInSeconds };
    localStorage.setItem('tutto_local_game', JSON.stringify(localStateToSave));
  });

  let lastOnlinePersistKey: string | null = null;
  store.subscribe((state) => {
    if (state.mode !== 'online' || !state.isHost || state.status !== 'lobby') {
      lastOnlinePersistKey = null;
      return;
    }
    const stable = {
      winningScore: state.winningScore,
      initialCards: state.initialCards,
      randomOrder: state.randomOrder,
      turnDuration: state.turnDuration,
      reconnectTimeout: state.reconnectTimeout,
      enforcedDiceMode: state.enforcedDiceMode,
    };
    const key = JSON.stringify(stable);
    if (key === lastOnlinePersistKey) return;
    lastOnlinePersistKey = key;
    localStorage.setItem('tutto_online_config', key);
  });
};
