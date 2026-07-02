import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  calculateNextTurn,
  calculateUndo,
  getLeaders,
  shuffleArray,
  buildGlobalStatsPayload,
} from '../utils/coreGameEngine';
import { parseJsonString } from '../utils/parseJson';
import { parseSavedDiceState, buildTurnKey } from '../utils/diceTurnState';
import { getEffectiveTurnDuration } from '../utils/turnDuration';
import i18n from '../i18n';
import playerColorsData from '../../playerColors.json';
import type {
  CardType,
  InitialCards,
  Player,
  CoreGameState,
  Toast,
  DiceSnapshot,
  GlobalStatsPayload,
  DiceMode,
} from '../types';

export const PLAYER_COLORS: string[] = playerColorsData.PLAYER_COLORS;

const INITIAL_CARDS: InitialCards = {
  Kleeblatt: 1, Feuerwerk: 5, Stop: 10, Kniffel: 5, Plus_Minus: 5,
  x2: 5, '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
};

const createInitialPlayer = (name: string): Player => ({
  name, score: 0, times1000PointsDeducted: 0, timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0, timesKniffelFailed: 0, timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0, timesPlusMinusFailed: 0, timesFeuerwerkReceived: 0,
  timesSkipped: 0, timesx2Received: 0, totalTurns: 0, busts: 0,
  feuerwerkBusts: 0, x2Busts: 0, feuerwerkPointsScored: 0, x2PointsScored: 0,
  position: 0,
});


type GameMode = 'local' | 'online';
type GameStatus = 'lobby' | 'playing';

interface ReconnectSession {
  roomId: string;
  myName: string;
}

interface JoinRoomResponse {
  success: boolean;
  isHost?: boolean;
  error?: string;
}

type ConfigKeys = 'winningScore' | 'initialCards' | 'randomOrder' | 'turnDuration' | 'reconnectTimeout';

export interface GameStore extends CoreGameState {
  mode: GameMode;
  deviceId: string | null;
  isOnline: boolean;
  showReconnectPopup: boolean;
  roomId: string | null;
  isHost: boolean;
  hostId: string | null;
  myName: string | null;
  toasts: Toast[];
  diceMode: DiceMode;
  audioEnabled: boolean;
  randomOrder: boolean;
  turnDuration: number;
  reconnectTimeout: number;
  turnTimeRemaining: number | null;
  kickTimeRemaining?: number | null;
  chartValues: number[][];
  chartNames: string[];
  chartLabels: number[];
  status: GameStatus;
  liveTurnState: DiceSnapshot | null;
  justReconnected: boolean;
  pendingReconnectSession?: ReconnectSession | null;

  reset: () => void;
  clearPendingReconnect: () => void;
  cancelReconnect: (roomId?: string | null, name?: string | null) => void;
  init: (deviceId: string) => void;
  setMode: (mode: GameMode) => void;
  addToast: (message: string) => void;
  removeToast: (id: number) => void;
  setDiceMode: (val: DiceMode) => void;
  setAudioEnabled: (val: boolean) => void;
  updateConfig: (config: Partial<Pick<GameStore, ConfigKeys>>) => void;
  setWinningScore: (val: number) => void;
  setInitialCards: (val: InitialCards) => void;
  setRandomOrder: (val: boolean) => void;
  setTurnDuration: (val: number) => void;
  setReconnectTimeout: (val: number) => void;
  resetGeneralSettings: () => void;
  resetInitialCards: () => void;
  addPlayer: (name: string) => void;
  removePlayer: (name: string) => void;
  reorderPlayers: (newPlayers: Player[]) => void;
  changePlayerColor: (name: string, color: string) => void;
  changeMyColor: (newColor: string) => void;
  connectSocket: (url?: string) => void;
  joinRoom: (room: string, name: string, isReconnect?: boolean) => Promise<JoinRoomResponse>;
  leaveRoom: () => void;
  kickPlayer: (targetSocketId: string) => void;
  setLiveTurnState: (snapshot: DiceSnapshot | null) => void;
  pushState: () => void;
  startLocalTimers: () => void;
  stopLocalTimers: () => void;
  syncOnlineTimers: () => void;
  stopOnlineTimers: () => void;
  startGame: () => void;
  endGame: () => void;
  nextTurn: (scoreInput: number, isSuccess?: boolean) => void;
  undo: () => void;
  buildGlobalStatsPayload: () => GlobalStatsPayload;
  sendOnlineStats: () => void;
}

let socket: Socket | null = null;
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
  winningScore: 6000,
  initialCards: INITIAL_CARDS,
  diceMode: 'physical',
  audioEnabled: true,
  randomOrder: true,
  turnDuration: 120,
  reconnectTimeout: 60,
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

const validateOnlineConfig = (config: unknown): Partial<Pick<GameStore, ConfigKeys>> => {
  if (typeof config !== 'object' || config === null) return {};
  const valid: Partial<Pick<GameStore, ConfigKeys>> = {};
  const c = config as Record<string, unknown>;
  // Ranges must match the server's applyValidatedConfig (server/index.ts):
  // values the server would reject are dropped here too, so the lobby never
  // shows a setting the server silently refused.
  if (typeof c.winningScore === 'number' && c.winningScore >= 1000 && c.winningScore <= 99999) valid.winningScore = c.winningScore;
  if (typeof c.randomOrder === 'boolean') valid.randomOrder = c.randomOrder;
  if (typeof c.turnDuration === 'number' && (c.turnDuration === 0 || (c.turnDuration >= 10 && c.turnDuration <= 600))) valid.turnDuration = c.turnDuration;
  if (typeof c.reconnectTimeout === 'number' && (c.reconnectTimeout === 0 || (c.reconnectTimeout >= 10 && c.reconnectTimeout <= 3600))) valid.reconnectTimeout = c.reconnectTimeout;
  if (typeof c.initialCards === 'object' && c.initialCards !== null) {
    const VALID_CARD_TYPES = ['Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2', '200', '300', '400', '500', '600'];
    const validCards: InitialCards = {};
    for (const [key, val] of Object.entries(c.initialCards)) {
      if (VALID_CARD_TYPES.includes(key) && typeof val === 'number' && val >= 0 && val <= 99) {
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
const reanchorLocalClock = (state: {
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

export const useGameStore = create<GameStore>()(
  immer((set, get) => ({
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

    cancelReconnect: (roomId?: string | null, name?: string | null) => {
      localStorage.removeItem('tutto_dice_turn_state');
      sessionStorage.removeItem('tutto_online_session');
      set({ pendingReconnectSession: null, liveTurnState: null, showReconnectPopup: false });

      if (!roomId) return;

      const tempSocket = io(window.location.origin);
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(timeoutId);
        tempSocket.disconnect();
      };
      const timeoutId = setTimeout(cleanup, 10000);

      tempSocket.on('connect_error', cleanup);
      tempSocket.on('connect', () => {
        const savedColor = localStorage.getItem('tutto_color');
        tempSocket.emit('joinRoom', {
          roomId,
          name,
          deviceId: get().deviceId,
          color: savedColor,
        }, (res: JoinRoomResponse) => {
          if (res?.success) tempSocket.emit('leaveRoom');
          cleanup();
        });
      });
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
        if (socket) { socket.disconnect(); socket = null; }
        get().stopOnlineTimers();
        get().startLocalTimers();
      } else {
        get().stopLocalTimers();
      }
    },

    addToast: (message) => set((state) => {
      state.toasts.push({ id: Date.now() + Math.random(), message });
    }),
    removeToast: (id) => set((state) => {
      state.toasts = state.toasts.filter(t => t.id !== id);
    }),

    setDiceMode: (val) => {
      set({ diceMode: val });
      localStorage.setItem('tutto_diceMode', val);
    },

    setAudioEnabled: (val) => {
      set({ audioEnabled: val });
      localStorage.setItem('tutto_audioEnabled', String(val));
    },

    updateConfig: (config) => {
      set((state) => { Object.assign(state, config); });
      const s = get();
      if (s.isOnline && s.isHost && s.roomId && socket) {
        socket.emit('updateConfig', {
          roomId: s.roomId,
          winningScore: s.winningScore,
          initialCards: s.initialCards,
          randomOrder: s.randomOrder,
          turnDuration: s.turnDuration,
          reconnectTimeout: s.reconnectTimeout,
        });
      }
    },

    setWinningScore: (val) => get().updateConfig({ winningScore: val }),
    setInitialCards: (val) => get().updateConfig({ initialCards: val }),
    setRandomOrder: (val) => get().updateConfig({ randomOrder: val }),
    setTurnDuration: (val) => get().updateConfig({ turnDuration: val }),
    setReconnectTimeout: (val) => get().updateConfig({ reconnectTimeout: val }),
    resetGeneralSettings: () => get().updateConfig({ winningScore: 6000, randomOrder: true, turnDuration: 120, reconnectTimeout: 60 }),
    resetInitialCards: () => get().updateConfig({ initialCards: INITIAL_CARDS }),

    addPlayer: (name) => {
      set((state) => {
        const usedColors = state.players.map(p => p.color);
        let color = PLAYER_COLORS.find(c => !usedColors.includes(c));
        if (!color) color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
        const newPlayer = createInitialPlayer(name);
        newPlayer.color = color;
        state.players.push(newPlayer);
      });
    },

    removePlayer: (name) => {
      set((state) => { state.players = state.players.filter(p => p.name !== name); });
    },

    reorderPlayers: (newPlayers) => {
      set({ players: newPlayers, randomOrder: false });
      if (get().isOnline && get().isHost && socket) {
        socket.emit('reorderPlayers', { roomId: get().roomId, newPlayers });
      }
    },

    changePlayerColor: (name, color) => {
      set((state) => {
        const p = state.players.find(p => p.name === name);
        if (p) p.color = color;
      });
    },

    changeMyColor: (newColor) => {
      localStorage.setItem('tutto_color', newColor);
      get().changePlayerColor(get().myName ?? '', newColor);
      if (get().isOnline && socket) {
        socket.emit('updatePlayerColor', { roomId: get().roomId, color: newColor });
      }
    },

    connectSocket: (url?: string) => {
      if (!socket) {
        const sock = io(url ?? window.location.origin);
        socket = sock;

        sock.on('gameState', (serverState: Partial<GameStore>) => {
          const wasFinished = get().finished;
          set((prev) => {
            const wasDisconnected = prev.showReconnectPopup;

            if (prev.mode === 'online' && prev.status === 'lobby' && serverState.status === 'lobby') {
              if (prev.winningScore !== serverState.winningScore) prev.toasts.push({ id: Date.now() + Math.random(), message: `Winning score: ${serverState.winningScore}` });
              if (prev.turnDuration !== serverState.turnDuration) prev.toasts.push({ id: Date.now() + Math.random(), message: `Turn timer: ${serverState.turnDuration === 0 ? 'Off' : serverState.turnDuration + 's'}` });
              if (prev.reconnectTimeout !== serverState.reconnectTimeout) prev.toasts.push({ id: Date.now() + Math.random(), message: `Kick timer: ${serverState.reconnectTimeout}s` });
              if (JSON.stringify(prev.initialCards) !== JSON.stringify(serverState.initialCards)) prev.toasts.push({ id: Date.now() + Math.random(), message: 'Deck composition changed' });
            }
            if (prev.mode === 'online' && prev.status === 'playing' && serverState.status === 'lobby' && !prev.finished && (serverState.players?.length ?? 0) >= 2) {
              prev.toasts.push({ id: Date.now() + Math.random(), message: 'Host ended game early' });
            }
            Object.assign(prev, serverState);

            if (wasDisconnected && serverState.status === 'playing') {
              prev.justReconnected = true;
            }
            prev.showReconnectPopup = false;
          });
          get().syncOnlineTimers();

          if (!wasFinished && get().finished) {
            get().sendOnlineStats();
          }
        });

        sock.on('playerDisconnected', (name: string) => {
          const seconds = get().reconnectTimeout || 60;
          get().addToast(`${name} disconnected! They have ${seconds} seconds to reconnect.`);
        });

        sock.on('nameConflictWithDisconnected', (name: string) => {
          get().addToast(`Someone tried to join as "${name}", which belongs to a disconnected player. Kick them below to free up the name.`);
        });

        sock.on('hostId', (hostSocketId: string) => {
          set({ isHost: hostSocketId === sock.id, hostId: hostSocketId });
        });

        sock.on('kicked', () => {
          get().addToast('You were kicked by the host');
          set({ roomId: null, isHost: false, hostId: null, myName: null });
          sessionStorage.removeItem('tutto_online_session');
          get().setMode('local');
        });

        sock.on('gameAborted', () => {
          get().addToast(i18n.t('game.aborted'));
        });

        sock.on('disconnect', () => {
          if (get().mode === 'online') set({ showReconnectPopup: true });
        });

        sock.on('connect', () => {
          const { roomId, myName, deviceId } = get();
          if (roomId && myName) {
            const savedColor = localStorage.getItem('tutto_color');
            sock.emit('joinRoom', { roomId, name: myName, deviceId, color: savedColor }, (res: JoinRoomResponse) => {
              if (res.success) set({ isHost: res.isHost ?? false });
            });
          }
        });
      }
    },

    joinRoom: (room, name, isReconnect = false) => {
      if (!isReconnect) {
        localStorage.removeItem('tutto_dice_turn_state');
        set({ liveTurnState: null });
      }
      return new Promise<JoinRoomResponse>((resolve) => {
        let initialConfig: Partial<Pick<GameStore, ConfigKeys>> | undefined = undefined;
        try {
          const storedConfigStr = localStorage.getItem('tutto_online_config');
          if (storedConfigStr) {
            // Only transmit fields the server would accept — same validator the
            // lobby uses when loading this config, so both stay in sync.
            const validated = validateOnlineConfig(JSON.parse(storedConfigStr));
            if (Object.keys(validated).length > 0) initialConfig = validated;
          }
        } catch (e) {
          console.error('Failed to parse online config for joinRoom', e);
        }

        get().connectSocket();
        const savedColor = localStorage.getItem('tutto_color');
        if (!socket) {
          resolve({ success: false, error: 'Socket not connected' });
          return;
        }
        socket.emit('joinRoom', { roomId: room, name, deviceId: get().deviceId, color: savedColor, initialConfig }, (res: JoinRoomResponse) => {
          if (res.success) {
            set({ roomId: room, isHost: res.isHost ?? false, myName: name, mode: 'online', isOnline: true });
            sessionStorage.setItem('tutto_online_session', JSON.stringify({ roomId: room, myName: name }));
            
            if (res.isHost && !isReconnect && initialConfig) {
              get().addToast(i18n.t('lobby.savedSettingsLoaded'));
            }
          }
          resolve(res);
        });
      });
    },

    leaveRoom: () => {
      if (socket) socket.emit('leaveRoom');
      get().stopOnlineTimers();
      sessionStorage.removeItem('tutto_online_session');
      localStorage.removeItem('tutto_dice_turn_state');
      set({
        players: [],
        currentPlayerIndex: null,
        currentCard: null,
        cards: [],
        round: 1,
        finished: false,
        status: 'lobby',
        roomId: null,
        isHost: false,
        myName: null,
        liveTurnState: null,
      });
    },

    kickPlayer: (targetSocketId) => {
      if (get().isHost && socket) socket.emit('kickPlayer', targetSocketId);
    },

    setLiveTurnState: (snapshot) => {
      set({ liveTurnState: snapshot });
      if (snapshot) {
        const s = get();
        const snapshotWithPlayer = {
          ...snapshot,
          playerName: s.currentPlayerIndex !== null ? s.players[s.currentPlayerIndex]?.name : undefined,
          // Stamped so a later restore (see DiceGame's mount effect) can tell this
          // turn apart from a stale snapshot left behind by an earlier turn — e.g.
          // one the server's turn timer advanced past while this player was
          // disconnected, which never got the chance to clear its own cache entry.
          turnKey: buildTurnKey(s.roomId, s.round, s.currentPlayerIndex, s.currentCard),
        };
        localStorage.setItem('tutto_dice_turn_state', JSON.stringify(snapshotWithPlayer));
      }
      if (get().isOnline) get().pushState();
    },

    pushState: () => {
      const s = get();
      if (s.isOnline && socket) {
        const {
          players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
          randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
          previousScore, previousCard, previousLeaders, previousWasBust, previousHighestTurnScore,
          chartValues, chartNames, chartLabels, status, liveTurnState,
        } = s;
        socket.emit('pushState', {
          roomId: s.roomId,
          newState: {
            players, currentPlayerIndex, currentCard, cards, round, winningScore, initialCards,
            randomOrder, turnDuration, reconnectTimeout, finished, gameTimeInSeconds,
            previousScore, previousCard, previousLeaders, previousWasBust, previousHighestTurnScore,
            chartValues, chartNames, chartLabels, status, liveTurnState,
          },
        });
      }
    },

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
            // expiry (see server/index.ts startServerTurnTimer) — it advances the
            // turn and pushes the resulting gameState even if every client,
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

    startGame: () => {
      const s = get();
      if (s.isOnline && !s.isHost) return;

      set((state) => {
        const resetPlayers = state.players.map(p => ({
          ...createInitialPlayer(p.name),
          color: p.color,
          socketId: p.socketId,
          disconnected: p.disconnected,
        }));
        state.players = state.randomOrder ? shuffleArray(resetPlayers) : resetPlayers;
        state.round = 1;
        state.gameStartTime = Date.now();
        state.gameTimeInSeconds = 0;
        state.finished = false;
        state.chartValues = state.players.map(() => []);
        state.chartNames = state.players.map(p => p.name);
        state.chartLabels = [];
        state.previousCard = null;
        state.previousScore = null;
        state.previousLeaders = null;
        state.previousWasBust = false;
        state.previousHighestTurnScore = 0;
        state.status = 'playing';

        const deck = shuffleArray(
          (Object.keys(state.initialCards) as CardType[]).flatMap(card =>
            Array.from({ length: state.initialCards[card] ?? 0 }, (): CardType => card)
          )
        );
        state.currentCard = deck.shift() ?? null;
        state.cards = deck;
        state.currentPlayerIndex = 0;
        state.liveTurnState = null;
      });
      localStorage.removeItem('tutto_dice_turn_state');

      if (get().isOnline) {
        get().pushState();
        get().syncOnlineTimers();
      } else {
        get().startLocalTimers();
      }
    },

    endGame: () => {
      if (get().isOnline && !get().isHost) return;
      get().stopLocalTimers();
      set({
        finished: false,
        status: 'lobby',
        currentPlayerIndex: null,
        gameTimeInSeconds: 0,
        round: 1,
        currentCard: null,
        cards: [],
        turnTimeRemaining: null,
        liveTurnState: null,
        previousCard: null,
        previousScore: null,
        previousLeaders: null,
        previousWasBust: false,
        previousHighestTurnScore: 0,
        chartValues: [],
        chartNames: [],
        chartLabels: [],
      });
      localStorage.removeItem('tutto_dice_turn_state');
      if (get().isOnline) get().pushState();
    },

    nextTurn: (scoreInput, isSuccess = false) => {
      const s = get();
      if (s.finished) return;
      if (s.currentPlayerIndex === null) return;

      const result = calculateNextTurn(
        s as CoreGameState & { currentPlayerIndex: number },
        scoreInput,
        isSuccess,
      );

      set((state) => {
        state.previousCard = result.previousCard;
        state.previousScore = result.previousScore;
        state.previousLeaders = result.previousLeaders;
        state.previousWasBust = result.previousWasBust;
        state.previousHighestTurnScore = result.previousHighestTurnScore;

        if (result.isRoundEnd) {
          state.chartValues.forEach((vals, i) => vals.push(result.players[i].score));
          state.chartLabels.push(state.round);
        }

        state.players = result.players;

        if (result.isGameOver) {
          state.finished = true;
          state.currentPlayerIndex = null;
          if (state.gameStartTime) {
            state.gameTimeInSeconds = Math.floor((Date.now() - state.gameStartTime) / 1000);
          }
        } else {
          state.currentPlayerIndex = result.nextIndex;
          state.round = result.nextRound;
          state.cards = result.newDeck;
          state.currentCard = result.drawnCard;
        }
        state.liveTurnState = null;
        localStorage.removeItem('tutto_dice_turn_state');
      });

      // Stats are intentionally only tracked for online games. Local games do not
      // submit statistics — by design, not an oversight.
      if (get().finished && get().isOnline) get().sendOnlineStats();
      if (get().isOnline) {
        get().pushState();
        get().syncOnlineTimers();
      }
    },

    undo: () => {
      const s = get();
      if (!s.previousCard || s.previousCard === 'Stop') return;

      const result = calculateUndo(s);
      if (!result) return;

      set((state) => {
        if (result.isRoundEndUndo) {
          state.chartValues = state.chartValues.map(vals => vals.slice(0, -1));
          state.chartLabels = state.chartLabels.slice(0, -1);
        }
        state.players = result.players;
        state.currentPlayerIndex = result.nextIndex;
        state.round = result.nextRound;
        state.cards = result.newDeck;
        state.currentCard = result.drawnCard;
        state.previousCard = null;
        state.previousScore = null;
        state.previousLeaders = null;
        state.previousWasBust = false;
        state.previousHighestTurnScore = 0;
      });

      if (get().isOnline) {
        get().pushState();
        get().syncOnlineTimers();
      }
    },

    buildGlobalStatsPayload: () => {
      const s = get();
      const isDefaultGame = s.winningScore === 6000 && JSON.stringify(s.initialCards) === JSON.stringify(INITIAL_CARDS);
      return buildGlobalStatsPayload(s.players, s.gameTimeInSeconds, isDefaultGame);
    },

    sendOnlineStats: () => {
      const s = get();
      const me = s.players.find(p => p.name === s.myName);
      if (me && socket) {
        const leaders = getLeaders(s.players);
        const didIWin = leaders.find(l => l.name === me.name) ? 1 : 0;
        socket.emit('endGameStats', {
          roomId: s.roomId,
          deviceId: s.deviceId,
          stats: {
            gamesPlayed: 1, wins: didIWin, totalPlaytime: s.gameTimeInSeconds || 0,
            pointsDeducted: me.times1000PointsDeducted || 0, plusMinusCompleted: me.timesPlusMinusCompleted || 0,
            plusMinusFailed: me.timesPlusMinusFailed || 0, kniffelCompleted: me.timesKniffelCompleted || 0,
            kniffelFailed: me.timesKniffelFailed || 0, skipped: me.timesSkipped || 0,
            feuerwerkReceived: me.timesFeuerwerkReceived || 0, kleeblattFailed: me.timesKleeblattFailed || 0,
            kleeblattCompleted: me.timesKleeblattCompleted || 0, x2Received: me.timesx2Received || 0,
            totalTurns: me.totalTurns || 0, busts: me.busts || 0,
            feuerwerkBusts: me.feuerwerkBusts || 0, x2Busts: me.x2Busts || 0,
            feuerwerkPointsScored: me.feuerwerkPointsScored || 0, x2PointsScored: me.x2PointsScored || 0,
            highestTurnScore: me.highestTurnScore || 0, totalScore: me.score || 0,
            fastestWinTurns: didIWin ? (me.totalTurns || 0) : null,
            fastestLossTurns: !didIWin ? (me.totalTurns || 0) : null,
          },
        });
      }

      // Global stats are submitted by the host via socket so no secret token
      // needs to be compiled into the client bundle. The server validates the
      // sender is the room host by socket identity.
      if (s.isHost && socket) {
        socket.emit('submitGlobalStats', {
          roomId: s.roomId,
          payload: get().buildGlobalStatsPayload(),
        });
      }
    },
  })),
);

// The 1s game timer mutates gameTimeInSeconds every tick; persisting the whole
// snapshot on each tick would rewrite localStorage once per second for the entire
// game. We therefore skip the write unless something other than the timer changed
// — the current gameTimeInSeconds still rides along whenever a real change is saved.
let lastLocalPersistKey: string | null = null;
useGameStore.subscribe((state) => {
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
    previousLeaders: state.previousLeaders, chartValues: state.chartValues,
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
useGameStore.subscribe((state) => {
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
