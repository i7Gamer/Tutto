import { localStore, sessionStore } from '../utils/storage';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { parseJsonString } from '../utils/parseJson';
import { parseSavedDiceState, DICE_TURN_STATE_KEY } from '../utils/diceTurnState';
import { parseReconnectSession } from '../utils/reconnectSession';
import {
  DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE, DEFAULT_TURN_DURATION, DEFAULT_RECONNECT_TIMEOUT,
  DEFAULT_DICE_MODE, DEFAULT_RULESET, isValidDiceMode,
} from '../utils/configValidation';
import { roomPhase } from '../utils/roomPhase';
import type { CoreGameState, DiceSnapshot, DiceMode, Ruleset } from '../types';
import type { GameStore, GameStatus, PreGameStats, FinishedGameSnapshot } from './storeTypes';
import { validateOnlineConfig, reanchorLocalClock, attachPersistence, pickLocalGameState } from './persistence';
import { createTimerSlice } from './timers';
import { createConfigSlice } from './configSlice';
import { createSocketSlice, clearRoomState, clearPendingPush, clearRejoinWatchdog } from './socketSlice';
import { createGameSlice } from './gameSlice';
import { disconnectSocket } from './socketRef';

export type { GameStore } from './storeTypes';
export { _resetTimersForTests } from './timers';
export { _resetSocketSliceForTests } from './socketSlice';
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
  turnDeadline: number | null;
  chartValues: number[][];
  chartNames: string[];
  chartLabels: number[];
  status: GameStatus;
  liveTurnState: DiceSnapshot | null;
  justReconnected: boolean;
  preGameStats: PreGameStats | null;
  finishedGameSnapshot: FinishedGameSnapshot | null;
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
  turnDeadline: null,
  previousScore: null,
  previousCard: null,
  previousLeaders: null,
  previousWasBust: false,
  // See noUndoableTurn (coreGameEngine.ts) for why this starts undefined
  // rather than false.
  previousWasSuccess: undefined,
  previousHighestTurnScore: 0,
  previousHighestFeuerwerkTurnScore: 0,
  previousHighestX2TurnScore: 0,
  previousPlayerName: null,
  previousTurnSummary: null,
  chartValues: [],
  chartNames: [],
  chartLabels: [],
  status: 'lobby',
  liveTurnState: null,
  justReconnected: false,
  preGameStats: null,
  finishedGameSnapshot: null,
  historyLog: [],
});

export const useGameStore = create<GameStore>()(
  immer((set, get, api) => ({
    mode: 'local',
    deviceId: null,
    isOnline: false,
    showReconnectPopup: false,
    // Whether this client has received its first gameState for the current
    // room — the config-diff toasts stay quiet until it has (socketSlice).
    roomStateSynced: false,
    roomId: null,
    isHost: false,
    hostId: null,
    myName: null,
    lastAppliedStateVersion: null,
    toasts: [],
    reactions: [],
    ...createInitialLocalState(),

    // Cross-cutting lifecycle actions live here in the composition root; the
    // per-concern actions come from the slices spread below.

    reset: () => {
      // Module state, so clearRoomState below cannot reach it: a push parked
      // for a room this store is throwing away must not be flushed into the
      // next one by a later reconnect.
      clearPendingPush();
      // Same reason, same reach: a rejoin deadline armed for the room being
      // thrown away must not toast "No response from the server" into the
      // fresh one.
      clearRejoinWatchdog();
      set({
        ...createInitialLocalState(),
        ...clearRoomState(),
        mode: 'local',
        isOnline: false,
        toasts: [],
        reactions: [],
        showReconnectPopup: false,
        roomStateSynced: false,
        pendingReconnectSession: null,
      });
    },

    clearPendingReconnect: () => {
      sessionStore.remove('tutto_online_session');
      set({ pendingReconnectSession: null });
    },

    init: (deviceId: string) => {
      const parsed = parseJsonString<Partial<GameStore>>(localStore.read('tutto_local_game'));
      // A join link has already switched this client to online play by the
      // time init() runs: <Home/> mounts on App's first render and its link
      // effect flushes before App's own (child effects run first). Restoring
      // the saved game on top of that invitation routes App straight into
      // <Game/>, unmounting the only screen that consumes the link — so the
      // restore waits. Nothing is lost: the save stays on disk (the local
      // persistence subscriber is inert while online), and choosing local play
      // runs it through setMode('local') instead.
      const savedGamePostponed = !!parsed && get().mode !== 'local';

      // Validated rather than cast: RestoreSessionPopup renders this room id
      // into its prose and hands both fields to joinRoom on "Yes", so a
      // corrupted entry used to ask about "room (undefined)" and then join a
      // room by that name. Dropped when unusable — left in place it would be
      // re-read, and re-prompted for, on every mount.
      const rawSession = sessionStore.read('tutto_online_session');
      const session = parseReconnectSession(rawSession);
      if (rawSession !== null && session === null) sessionStore.remove('tutto_online_session');

      set((state) => {
        state.deviceId = deviceId;
        if (parsed && !savedGamePostponed) {
          Object.assign(state, pickLocalGameState(parsed));
          reanchorLocalClock(state);
        }
        if (session) state.pendingReconnectSession = session;
      });

      // A restored mid-game local save must also restart the 1-second game
      // clock: App routes straight into <Game/> (the restored state is already
      // "playing"), so setMode('local') — the only other startLocalTimers
      // caller besides startGame — never runs on this path. Without this the
      // displayed clock stays frozen at the saved value, every save persists
      // that stale number, and the NEXT reload re-anchors gameStartTime from
      // it — silently discarding all playtime since this one.
      if (get().mode === 'local' && roomPhase(get()) === 'playing' && get().currentPlayerIndex !== null) {
        get().startLocalTimers();
      }

      // Validation of dice turn state cache ownership. init() runs at app
      // mount, BEFORE a pending online reconnect can be accepted
      // (setMode('online') only fires from the reconnect popup), so `mode` is
      // still 'local' here even when the cache belongs to an online game —
      // the pending session (restored just above) is the discriminator.
      // Judging an online game's cache against the local roster would nearly
      // always mismatch and silently delete the reconnecting player's
      // in-progress turn. DiceGame's turnKey check (run later, against real
      // post-reconnect state) discards genuinely stale snapshots in every
      // mode, including this one. A postponed local restore is the same
      // situation from the other side: the roster the cache would be judged
      // against is still on disk rather than in state, so checking it here
      // would delete the half-rolled turn of the game being kept for later.
      const restoredDice = parseSavedDiceState(localStore.read(DICE_TURN_STATE_KEY));
      if (restoredDice && restoredDice.playerName && !get().pendingReconnectSession && !savedGamePostponed) {
        const activePlayer = get().currentPlayerIndex !== null ? get().players[get().currentPlayerIndex!] : null;
        if (!activePlayer || activePlayer.name !== restoredDice.playerName) {
          localStore.remove(DICE_TURN_STATE_KEY);
        }
      }

      // An invalid/corrupted value (or one predating this key) is left alone —
      // the initial state's diceMode already holds DEFAULT_DICE_MODE.
      const storedDiceMode = localStore.read('tutto_diceMode');
      if (isValidDiceMode(storedDiceMode)) set({ diceMode: storedDiceMode });

      const storedAudioEnabled = localStore.read('tutto_audioEnabled');
      if (storedAudioEnabled !== null) {
        set({ audioEnabled: storedAudioEnabled === 'true' });
      }

      const storedHapticsEnabled = localStore.read('tutto_hapticsEnabled');
      if (storedHapticsEnabled !== null) {
        set({ hapticsEnabled: storedHapticsEnabled === 'true' });
      }
    },

    setMode: (mode) => {
      const isLocal = mode === 'local';

      let parsed: Partial<GameStore> | null = null;
      if (isLocal) {
        const rawLocal = parseJsonString<Partial<GameStore>>(localStore.read('tutto_local_game'));
        parsed = rawLocal ? pickLocalGameState(rawLocal) : null;
      } else {
        const raw = localStore.read('tutto_online_config');
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
        // Only (re)start the 1s clock when there is actually a game running to
        // tick: Home calls setMode('local') on mount with no game at all, and
        // starting the interval there just leaves it ticking (a no-op every
        // second, per the guard in startLocalTimers) until a game eventually
        // starts. The two real starters are startGame and this restore path —
        // a saved local game whose Object.assign above put it back in
        // progress. Same test as reanchorLocalClock above, deliberately: an
        // in-progress restore and a re-anchored clock are the same condition.
        const restored = get();
        if (roomPhase(restored) === 'playing' && restored.currentPlayerIndex !== null) {
          get().startLocalTimers();
        }
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
