import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { parseJsonString } from '../utils/parseJson';
import { parseSavedDiceState } from '../utils/diceTurnState';
import {
  DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE, DEFAULT_TURN_DURATION, DEFAULT_RECONNECT_TIMEOUT,
} from '../utils/configValidation';
import type { CoreGameState, DiceSnapshot, DiceMode } from '../types';
import type { GameStore, GameStatus, ReconnectSession } from './storeTypes';
import { validateOnlineConfig, reanchorLocalClock, attachPersistence } from './persistence';
import { createTimerSlice } from './timers';
import { createConfigSlice } from './configSlice';
import { createSocketSlice } from './socketSlice';
import { createGameSlice } from './gameSlice';
import { disconnectSocket } from './socketRef';

export type { GameStore } from './storeTypes';
export { _resetTimersForTests } from './timers';
export { PLAYER_COLORS } from './gameSlice';

const initialLocalState: Omit<CoreGameState, never> & {
  diceMode: DiceMode;
  audioEnabled: boolean;
  randomOrder: boolean;
  turnDuration: number;
  reconnectTimeout: number;
  turnTimeRemaining: number | null;
  chartValues: number[][];
  chartNames: string[];
  chartLabels: number[];
  status: GameStatus;
  liveTurnState: DiceSnapshot | null;
  justReconnected: boolean;
} = {
  players: [],
  currentPlayerIndex: null,
  currentCard: null,
  cards: [],
  round: 1,
  winningScore: DEFAULT_WINNING_SCORE,
  initialCards: DEFAULT_INITIAL_CARDS,
  diceMode: 'physical',
  audioEnabled: true,
  randomOrder: true,
  turnDuration: DEFAULT_TURN_DURATION,
  reconnectTimeout: DEFAULT_RECONNECT_TIMEOUT,
  finished: false,
  gameStartTime: null,
  gameTimeInSeconds: 0,
  turnTimeRemaining: null,
  previousScore: null,
  previousCard: null,
  previousLeaders: null,
  previousWasBust: false,
  previousHighestTurnScore: 0,
  chartValues: [],
  chartNames: [],
  chartLabels: [],
  status: 'lobby',
  liveTurnState: null,
  justReconnected: false,
};

export const useGameStore = create<GameStore>()(
  immer((set, get, api) => ({
    mode: 'local',
    deviceId: null,
    isOnline: false,
    showReconnectPopup: false,
    roomId: null,
    isHost: false,
    hostId: null,
    myName: null,
    toasts: [],
    ...initialLocalState,

    // Cross-cutting lifecycle actions live here in the composition root; the
    // per-concern actions come from the slices spread below.

    reset: () => {
      set({
        ...initialLocalState,
        mode: 'local',
        isOnline: false,
        roomId: null,
        isHost: false,
        hostId: null,
        myName: null,
        toasts: [],
        showReconnectPopup: false,
        pendingReconnectSession: null,
      });
    },

    clearPendingReconnect: () => {
      sessionStorage.removeItem('tutto_online_session');
      set({ pendingReconnectSession: null });
    },

    init: (deviceId: string) => {
      const parsed = parseJsonString<Partial<GameStore>>(localStorage.getItem('tutto_local_game'));

      set((state) => {
        state.deviceId = deviceId;
        if (parsed) {
          Object.assign(state, parsed);
          reanchorLocalClock(state);
        }
        const session = parseJsonString<ReconnectSession>(sessionStorage.getItem('tutto_online_session'));
        if (session) state.pendingReconnectSession = session;
      });

      // Validation of dice turn state cache ownership
      const restoredDice = parseSavedDiceState(localStorage.getItem('tutto_dice_turn_state'));
      if (restoredDice && restoredDice.playerName && get().mode === 'local') {
        const activePlayer = get().currentPlayerIndex !== null ? get().players[get().currentPlayerIndex!] : null;
        if (!activePlayer || activePlayer.name !== restoredDice.playerName) {
          localStorage.removeItem('tutto_dice_turn_state');
        }
      }

      const storedDiceMode = localStorage.getItem('tutto_diceMode') as DiceMode | null;
      if (storedDiceMode) set({ diceMode: storedDiceMode });

      const storedAudioEnabled = localStorage.getItem('tutto_audioEnabled');
      if (storedAudioEnabled !== null) {
        set({ audioEnabled: storedAudioEnabled === 'true' });
      }
    },

    setMode: (mode) => {
      const isLocal = mode === 'local';

      let parsed = null;
      if (isLocal) {
        parsed = parseJsonString<Partial<GameStore>>(localStorage.getItem('tutto_local_game'));
      } else {
        const raw = localStorage.getItem('tutto_online_config');
        if (raw) {
          try {
            parsed = validateOnlineConfig(JSON.parse(raw));
          } catch (e) {
            console.error('Failed to parse online config', e);
          }
        }
      }

      set((state) => {
        state.mode = mode;
        state.isOnline = !isLocal;

        // Reset advanced options to defaults to prevent bleeding between modes
        state.winningScore = initialLocalState.winningScore;
        state.randomOrder = initialLocalState.randomOrder;
        state.turnDuration = initialLocalState.turnDuration;
        state.reconnectTimeout = initialLocalState.reconnectTimeout;
        state.initialCards = JSON.parse(JSON.stringify(initialLocalState.initialCards));

        if (parsed) {
          Object.assign(state, parsed);
        }

        // If switching to local, ensure we don't accidentally load online settings
        // that somehow snuck into the local save file in older versions.
        if (isLocal && parsed) {
           if (parsed.winningScore !== undefined) state.winningScore = parsed.winningScore;
           if (parsed.randomOrder !== undefined) state.randomOrder = parsed.randomOrder;
           if (parsed.turnDuration !== undefined) state.turnDuration = parsed.turnDuration;
           if (parsed.reconnectTimeout !== undefined) state.reconnectTimeout = parsed.reconnectTimeout;
           if (parsed.initialCards !== undefined) state.initialCards = parsed.initialCards;
        }

        if (isLocal) {
          reanchorLocalClock(state);
        }
      });

      if (mode === 'local') {
        disconnectSocket();
        get().stopOnlineTimers();
        get().startLocalTimers();
      } else {
        get().stopLocalTimers();
      }
    },

    ...createConfigSlice(set, get, api),
    ...createTimerSlice(set, get, api),
    ...createSocketSlice(set, get, api),
    ...createGameSlice(set, get, api),
  })),
);

attachPersistence(useGameStore);
