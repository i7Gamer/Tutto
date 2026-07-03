import type { StoreApi } from 'zustand';
import { isValidWinningScore, isValidTurnDuration, isValidReconnectTimeout, isValidCardEntry } from '../utils/configValidation';
import type { CardType, InitialCards } from '../types';
import type { GameStore, GameMode, GameStatus, ConfigKeys } from './storeTypes';

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
    // Everything except the per-second timer field forms the "stability key".
    const stable = {
      players: state.players, currentPlayerIndex: state.currentPlayerIndex,
      currentCard: state.currentCard, cards: state.cards, round: state.round,
      winningScore: state.winningScore, diceMode: state.diceMode,
      initialCards: state.initialCards, randomOrder: state.randomOrder,
      turnDuration: state.turnDuration, reconnectTimeout: state.reconnectTimeout,
      finished: state.finished,
      previousScore: state.previousScore, previousCard: state.previousCard,
      previousLeaders: state.previousLeaders,
      // calculateUndo needs these two to revert bust counters and restore
      // highestTurnScore — previousCard is saved (undo stays available after a
      // reload), so dropping them would make a post-reload undo corrupt stats.
      previousWasBust: state.previousWasBust,
      previousHighestTurnScore: state.previousHighestTurnScore,
      chartValues: state.chartValues,
      chartNames: state.chartNames, chartLabels: state.chartLabels, status: state.status,
    };
    const key = JSON.stringify(stable);
    if (key === lastLocalPersistKey) return;
    lastLocalPersistKey = key;
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
    };
    const key = JSON.stringify(stable);
    if (key === lastOnlinePersistKey) return;
    lastOnlinePersistKey = key;
    localStorage.setItem('tutto_online_config', key);
  });
};
