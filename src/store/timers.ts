import { getEffectiveTurnDuration } from '../utils/turnDuration';
import type { CardType } from '../types';
import type { GameStore, ImmerStateCreator } from './storeTypes';

let gameTimerInterval: ReturnType<typeof setInterval> | null = null;
let turnTimerInterval: ReturnType<typeof setInterval> | null = null;
let turnTimerPlayerIndex: number | null = null;
let turnTimerCard: CardType | null = null;

const clearTurnTimer = () => {
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerInterval = null;
  turnTimerPlayerIndex = null;
  turnTimerCard = null;
};

// Test-only escape hatch: gameTimerInterval/turnTimerInterval are module-level,
// so vitest's module caching lets a timer started in one test keep firing into
// the next. useGameStore.getState().reset() only resets Zustand state — it
// never calls stopLocalTimers/stopOnlineTimers, so it can't stop them. Call
// this from a test's beforeEach alongside reset() to actually clear them.
export const _resetTimersForTests = (): void => {
  if (gameTimerInterval) clearInterval(gameTimerInterval);
  gameTimerInterval = null;
  clearTurnTimer();
};

type TimerSlice = Pick<GameStore, 'startLocalTimers' | 'stopLocalTimers' | 'syncOnlineTimers' | 'stopOnlineTimers'>;

export const createTimerSlice: ImmerStateCreator<TimerSlice> = (set, get) => ({
  startLocalTimers: () => {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    gameTimerInterval = setInterval(() => {
      const state = get();
      if (state.mode === 'local' && state.currentPlayerIndex !== null && !state.finished && state.gameStartTime) {
        set({ gameTimeInSeconds: Math.floor((Date.now() - state.gameStartTime) / 1000) });
      }
    }, 1000);
  },

  stopLocalTimers: () => {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    gameTimerInterval = null;
  },

  syncOnlineTimers: () => {
    const state = get();

    if (gameTimerInterval) clearInterval(gameTimerInterval);

    if (state.mode === 'online' && !state.finished && state.status === 'playing' && state.currentPlayerIndex !== null) {
      if (state.gameTimeInSeconds !== null && state.gameTimeInSeconds >= 0) {
        const localElapsed = state.gameStartTime
          ? Math.floor((Date.now() - state.gameStartTime) / 1000)
          : null;
        if (localElapsed === null || Math.abs(localElapsed - state.gameTimeInSeconds) > 2) {
          set({ gameStartTime: Date.now() - state.gameTimeInSeconds * 1000 });
        }
      }

      gameTimerInterval = setInterval(() => {
        const s = get();
        if (s.gameStartTime) {
          set({ gameTimeInSeconds: Math.floor((Date.now() - s.gameStartTime) / 1000) });
        }
      }, 1000);

      if (state.turnDuration > 0) {
        const playerChanged = state.currentPlayerIndex !== turnTimerPlayerIndex;
        const cardChanged = state.currentCard !== turnTimerCard;
        const justReconnected = state.justReconnected;

        if (playerChanged || cardChanged || justReconnected) {
          if (turnTimerInterval) clearInterval(turnTimerInterval);
          turnTimerPlayerIndex = state.currentPlayerIndex;
          turnTimerCard = state.currentCard;

          let remaining: number;
          const isNewTurn = playerChanged || cardChanged;
          if (!isNewTurn && justReconnected && state.turnTimeRemaining !== null && state.turnTimeRemaining !== undefined) {
            remaining = state.turnTimeRemaining;
          } else {
            remaining = getEffectiveTurnDuration(state.currentCard, state.turnDuration);
          }
          set({ turnTimeRemaining: remaining });

          // Display-only countdown. The server is the sole authority on turn
          // expiry (see server/turnTimers.ts startServerTurnTimer) — it advances
          // the turn and pushes the resulting gameState even if every client,
          // including the host, is disconnected or backgrounded. This interval
          // just stops counting at 0 and waits for that gameState to arrive.
          turnTimerInterval = setInterval(() => {
            const timeLeft = (get().turnTimeRemaining ?? 0) - 1;
            set({ turnTimeRemaining: timeLeft > 0 ? timeLeft : 0 });
            if (timeLeft <= 0) {
              clearInterval(turnTimerInterval!);
              turnTimerInterval = null;
            }
          }, 1000);
        }
      } else {
        clearTurnTimer();
        set({ turnTimeRemaining: null });
      }
    } else {
      clearTurnTimer();
      set({ turnTimeRemaining: null });
    }
  },

  stopOnlineTimers: () => {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    gameTimerInterval = null;
    clearTurnTimer();
  },
});
