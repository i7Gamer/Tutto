import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { parseJsonString } from '../utils/parseJson';
import { parseSavedDiceState, DICE_TURN_STATE_KEY } from '../utils/diceTurnState';
import {
  DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE, DEFAULT_TURN_DURATION, DEFAULT_RECONNECT_TIMEOUT,
  DEFAULT_DICE_MODE, DEFAULT_RULESET, isValidDiceMode,
} from '../utils/configValidation';
import type { CoreGameState, DiceSnapshot, DiceMode, Ruleset } from '../types';
import type { GameStore, GameStatus, ReconnectSession, PreGameStats } from './storeTypes';
import { validateOnlineConfig, reanchorLocalClock, attachPersistence, pickLocalGameState } from './persistence';
import { createTimerSlice } from './timers';
import { createConfigSlice } from './configSlice';
import { createSocketSlice, clearRoomState } from './socketSlice';
import { createGameSlice } from './gameSlice';
import { disconnectSocket } from './socketRef';

export type { GameStore } from './storeTypes';
export { _resetTimersForTests } from './timers';
export { PLAYER_COLORS } from './gameSlice';

// A factory, not a shared literal: the collections below land in mutable store
// state, and a single literal built at module load would be handed out again by
// every reset() for the rest of the session. Immer's copy-on-write hides that
// today, but one in-place write from a path Immer does not own would rewrite
// the defaults for good — the same hazard initialCards is copied for.
const createInitialLocalState = (): Omit<CoreGameState, never> & {
  diceMode: DiceMode;
  enforcedDiceMode: DiceMode | null;
  ruleset: Ruleset;
  audioEnabled: boolean;
  hapticsEnabled: boolean;
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
  preGameStats: PreGameStats | null;
} => ({
  players: [],
  currentPlayerIndex: null,
  currentCard: null,
  cards: [],
  round: 1,
  winningScore: DEFAULT_WINNING_SCORE,
  // Copied, never aliased — configValidation.ts's DEFAULT_INITIAL_CARDS is
  // shared with the server and every other consumer, and this one lands in
  // mutable store state. setMode copies it for the same reason.
  initialCards: { ...DEFAULT_INITIAL_CARDS },
  diceMode: DEFAULT_DICE_MODE,
  enforcedDiceMode: null,
  ruleset: DEFAULT_RULESET,
  audioEnabled: true,
  hapticsEnabled: true,
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
  previousHighestFeuerwerkTurnScore: 0,
  previousHighestX2TurnScore: 0,
  previousPlayerName: null,
  chartValues: [],
  chartNames: [],
  chartLabels: [],
  status: 'lobby',
  liveTurnState: null,
  justReconnected: false,
  preGameStats: null,
  historyLog: [],
});

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
    reactions: [],
    ...createInitialLocalState(),

    // Cross-cutting lifecycle actions live here in the composition root; the
    // per-concern actions come from the slices spread below.

    reset: () => {
      set({
        ...createInitialLocalState(),
        ...clearRoomState(),
        mode: 'local',
        isOnline: false,
        toasts: [],
        reactions: [],
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
          Object.assign(state, pickLocalGameState(parsed));
          reanchorLocalClock(state);
        }
        const session = parseJsonString<ReconnectSession>(sessionStorage.getItem('tutto_online_session'));
        if (session) state.pendingReconnectSession = session;
      });

      // Validation of dice turn state cache ownership. init() runs at app
      // mount, BEFORE a pending online reconnect can be accepted
      // (setMode('online') only fires from the reconnect popup), so `mode` is
      // still 'local' here even when the cache belongs to an online game —
      // the pending session (restored just above) is the discriminator.
      // Judging an online game's cache against the local roster would nearly
      // always mismatch and silently delete the reconnecting player's
      // in-progress turn. DiceGame's turnKey check (run later, against real
      // post-reconnect state) discards genuinely stale snapshots in every
      // mode, including this one.
      const restoredDice = parseSavedDiceState(localStorage.getItem(DICE_TURN_STATE_KEY));
      if (restoredDice && restoredDice.playerName && !get().pendingReconnectSession) {
        const activePlayer = get().currentPlayerIndex !== null ? get().players[get().currentPlayerIndex!] : null;
        if (!activePlayer || activePlayer.name !== restoredDice.playerName) {
          localStorage.removeItem(DICE_TURN_STATE_KEY);
        }
      }

      // An invalid/corrupted value (or one predating this key) is left alone —
      // the initial state's diceMode already holds DEFAULT_DICE_MODE.
      const storedDiceMode = localStorage.getItem('tutto_diceMode');
      if (isValidDiceMode(storedDiceMode)) set({ diceMode: storedDiceMode });

      const storedAudioEnabled = localStorage.getItem('tutto_audioEnabled');
      if (storedAudioEnabled !== null) {
        set({ audioEnabled: storedAudioEnabled === 'true' });
      }

      const storedHapticsEnabled = localStorage.getItem('tutto_hapticsEnabled');
      if (storedHapticsEnabled !== null) {
        set({ hapticsEnabled: storedHapticsEnabled === 'true' });
      }
    },

    setMode: (mode) => {
      const isLocal = mode === 'local';

      let parsed: Partial<GameStore> | null = null;
      if (isLocal) {
        const rawLocal = parseJsonString<Partial<GameStore>>(localStorage.getItem('tutto_local_game'));
        parsed = rawLocal ? pickLocalGameState(rawLocal) : null;
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

      const defaults = createInitialLocalState();

      set((state) => {
        state.mode = mode;
        state.isOnline = !isLocal;

        // Reset advanced options to defaults to prevent bleeding between modes
        state.winningScore = defaults.winningScore;
        state.randomOrder = defaults.randomOrder;
        state.turnDuration = defaults.turnDuration;
        state.reconnectTimeout = defaults.reconnectTimeout;
        state.initialCards = defaults.initialCards;
        // Meaningless offline (no host to enforce it) and never part of a local
        // save — reset so a leftover online enforcement doesn't survive a
        // switch to local and then bleed into the next online room.
        state.enforcedDiceMode = defaults.enforcedDiceMode;
        // Reset like the other config fields; `parsed` below re-applies the
        // value the target mode saved (local game save / online host config),
        // so a classic game resumes classic without bleeding across modes.
        state.ruleset = defaults.ruleset;

        if (parsed) {
          Object.assign(state, parsed);
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
