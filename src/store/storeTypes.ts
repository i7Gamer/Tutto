import type { StateCreator } from 'zustand';
import type {
  InitialCards,
  Player,
  CoreGameState,
  Toast,
  DiceSnapshot,
  GlobalStatsPayload,
  DiceMode,
} from '../types';

export type GameMode = 'local' | 'online';
export type GameStatus = 'lobby' | 'playing';

export interface ReconnectSession {
  roomId: string;
  myName: string;
}

export interface JoinRoomResponse {
  success: boolean;
  isHost?: boolean;
  error?: string;
}

export type ConfigKeys = 'winningScore' | 'initialCards' | 'randomOrder' | 'turnDuration' | 'reconnectTimeout';

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
  syncOnlineTimers: (serverRemaining?: number | null) => void;
  stopOnlineTimers: () => void;
  startGame: () => void;
  endGame: () => void;
  nextTurn: (scoreInput: number, isSuccess?: boolean) => void;
  undo: () => void;
  buildGlobalStatsPayload: () => GlobalStatsPayload;
  sendOnlineStats: () => void;
}

// The canonical zustand "slices" helper: a slice creator gets the same
// set/get the composed store was built with (immer middleware included), and
// returns just its own subset of GameStore actions.
export type ImmerStateCreator<T> = StateCreator<GameStore, [['zustand/immer', never]], [], T>;
