import { getEffectiveTurnDuration } from '../utils/turnDuration';
import type { GameStore, ImmerStateCreator } from './storeTypes';

// Module-local until the shared constant lands elsewhere (per A3's brief) —
// exported so other timer-adjacent code in this file/tests can reuse it
// instead of repeating the literal.
export const MS_PER_SECOND = 1000;

let gameTimerInterval: ReturnType<typeof setInterval> | null = null;
let turnTimerInterval: ReturnType<typeof setInterval> | null = null;
let turnTimerPlayerIndex: number | null = null;
// Deck size at the last countdown restart — mirrors the server's trigger
// (socketGameStateHandlers.ts): the card VALUE cannot see a classic mid-chain
// draw of the same card type, but a real draw always changes the deck.
let turnTimerDeckSize: number | null = null;

// The turn countdown is deadline-anchored (see syncOnlineTimers below): a tab
// throttled in the background stops firing the 1s interval, but the moment it
// becomes visible again this recomputes turnTimeRemaining from Date.now()
// instead of waiting for the next tick — otherwise the display keeps showing
// whatever stale value the last tick before backgrounding left behind.
let visibilityChangeHandler: (() => void) | null = null;

const attachVisibilityListener = (handler: () => void) => {
  if (visibilityChangeHandler) return;
  visibilityChangeHandler = handler;
  document.addEventListener('visibilitychange', visibilityChangeHandler);
};

const detachVisibilityListener = () => {
  if (visibilityChangeHandler) {
    document.removeEventListener('visibilitychange', visibilityChangeHandler);
    visibilityChangeHandler = null;
  }
};

const clearTurnTimer = () => {
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerInterval = null;
  turnTimerPlayerIndex = null;
  turnTimerDeckSize = null;
  detachVisibilityListener();
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

export const createTimerSlice: ImmerStateCreator<TimerSlice> = (set, get) => {
  // Deadline-anchored tick shared by the interval and the visibilitychange
  // handler: both just ask "how much time is actually left until
  // turnDeadline right now?" instead of trusting an accumulated decrement, so
  // a throttled/backgrounded tab that misses ticks self-corrects the instant
  // it (or the visibility listener) runs again.
  const tickTurnCountdown = () => {
    const deadline = get().turnDeadline;
    if (deadline === null) return;
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / MS_PER_SECOND));
    set({ turnTimeRemaining: remaining });
    if (remaining <= 0) {
      // The server is the sole authority on turn expiry (see
      // server/turnTimers.ts startServerTurnTimer) — it advances the turn and
      // pushes the resulting gameState even if every client, including the
      // host, is disconnected or backgrounded. This just stops counting at 0
      // and waits for that gameState to arrive.
      clearTurnTimer();
    }
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') tickTurnCountdown();
  };

  return {
    startLocalTimers: () => {
      if (gameTimerInterval) clearInterval(gameTimerInterval);
      gameTimerInterval = setInterval(() => {
        const state = get();
        if (state.mode === 'local' && state.currentPlayerIndex !== null && !state.finished && state.gameStartTime) {
          set({ gameTimeInSeconds: Math.floor((Date.now() - state.gameStartTime) / MS_PER_SECOND) });
        }
      }, MS_PER_SECOND);
    },

    stopLocalTimers: () => {
      if (gameTimerInterval) clearInterval(gameTimerInterval);
      gameTimerInterval = null;
    },

    // serverRemaining is the turnTimeRemaining carried by a fresh gameState event
    // (the server computes it in emitRoomState). When present it is authoritative
    // and restarts the display countdown — this keeps the client in sync after
    // throttled background tabs, and shows the true remaining time after a
    // page-reload reconnect (where the local turn tracking is empty and the turn
    // would otherwise be misread as brand new → full duration). Callers reacting
    // to local actions (nextTurn, undo, startGame) pass nothing and keep the
    // turn-change heuristic below.
    syncOnlineTimers: (serverRemaining?: number | null) => {
      const state = get();

      // Nulled, not just cleared: the non-playing path below never reassigns
      // it, and a dead handle left set makes the module's own "is running"
      // bookkeeping lie — stopLocalTimers/stopOnlineTimers already null theirs.
      if (gameTimerInterval) clearInterval(gameTimerInterval);
      gameTimerInterval = null;

      if (state.mode === 'online' && !state.finished && state.status === 'playing' && state.currentPlayerIndex !== null) {
        if (state.gameTimeInSeconds !== null && state.gameTimeInSeconds >= 0) {
          const localElapsed = state.gameStartTime
            ? Math.floor((Date.now() - state.gameStartTime) / MS_PER_SECOND)
            : null;
          if (localElapsed === null || Math.abs(localElapsed - state.gameTimeInSeconds) > 2) {
            set({ gameStartTime: Date.now() - state.gameTimeInSeconds * MS_PER_SECOND });
          }
        }

        gameTimerInterval = setInterval(() => {
          const s = get();
          if (s.gameStartTime) {
            set({ gameTimeInSeconds: Math.floor((Date.now() - s.gameStartTime) / MS_PER_SECOND) });
          }
        }, MS_PER_SECOND);

        if (state.turnDuration > 0) {
          const playerChanged = state.currentPlayerIndex !== turnTimerPlayerIndex;
          const deckChanged = state.cards.length !== turnTimerDeckSize;
          const justReconnected = state.justReconnected;
          const serverValue = typeof serverRemaining === 'number' ? serverRemaining : null;

          if (playerChanged || deckChanged || justReconnected || serverValue !== null) {
            if (turnTimerInterval) clearInterval(turnTimerInterval);
            turnTimerPlayerIndex = state.currentPlayerIndex;
            turnTimerDeckSize = state.cards.length;

            let remaining: number;
            const isNewTurn = playerChanged || deckChanged;
            if (serverValue !== null) {
              remaining = serverValue;
            } else if (!isNewTurn && justReconnected && state.turnTimeRemaining !== null && state.turnTimeRemaining !== undefined) {
              remaining = state.turnTimeRemaining;
            } else {
              remaining = getEffectiveTurnDuration(state.currentCard, state.turnDuration);
            }
            // Deadline-anchored, like syncOnlineTimers' own gameStartTime above:
            // an absolute point in wall-clock time that every future tick (or
            // visibility-triggered recheck) derives turnTimeRemaining from,
            // instead of accumulating a per-tick decrement that drifts once
            // ticks are missed (a throttled/backgrounded tab).
            const deadline = Date.now() + remaining * MS_PER_SECOND;
            set({ turnTimeRemaining: remaining, turnDeadline: deadline });

            attachVisibilityListener(handleVisibilityChange);
            turnTimerInterval = setInterval(tickTurnCountdown, MS_PER_SECOND);
          }
        } else {
          clearTurnTimer();
          set({ turnTimeRemaining: null, turnDeadline: null });
        }
      } else {
        clearTurnTimer();
        set({ turnTimeRemaining: null, turnDeadline: null });
      }
    },

    stopOnlineTimers: () => {
      if (gameTimerInterval) clearInterval(gameTimerInterval);
      gameTimerInterval = null;
      clearTurnTimer();
    },
  };
};
