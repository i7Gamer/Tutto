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
  // The name the server actually seated this client under. Differs from the
  // requested name when rejoining a running game: mid-game renames are
  // refused server-side (names are the identity key for pushState merging),
  // so the client must adopt the seat's existing name.
  name?: string;
}

export type ConfigKeys = 'winningScore' | 'initialCards' | 'randomOrder' | 'turnDuration' | 'reconnectTimeout' | 'enforcedDiceMode';

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
  // Host-only room config: null means every player uses their own diceMode
  // (the default); a DiceMode value pins that mode for everyone's own turn,
  // overriding their personal preference (see Game.tsx's effectiveDiceMode).
  enforcedDiceMode: DiceMode | null;
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
  setEnforcedDiceMode: (val: DiceMode | null) => void;
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
