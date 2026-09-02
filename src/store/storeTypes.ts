import type { StateCreator } from 'zustand';
import type { ConfigKeys } from '../types';
import type {
  InitialCards,
  Player,
  CoreGameState,
  Toast,
  Reaction,
  DiceSnapshot,
  GlobalStatsPayload,
  DiceMode,
  Ruleset,
  CardType,
  TurnSummary,
  DeviceStatsRow,
} from '../types';

export type GameMode = 'local' | 'online';
export type GameStatus = 'lobby' | 'playing';

/** What buildGlobalStatsPayload needs, frozen at the moment the game ended. */
export interface FinishedGameSnapshot {
  players: Player[];
  round: number;
  gameTimeInSeconds: number;
}

export interface ReconnectSession {
  roomId: string;
  myName: string;
}

export interface JoinRoomResponse {
  success: boolean;
  isHost?: boolean;
  error?: string;
  // Which refusal `error` is describing, for translating it (see
  // src/utils/joinErrors.ts). Absent on a success, and from any server older
  // than the codes — the prose is then shown as-is.
  code?: string;
  // The name the server actually seated this client under. Differs from the
  // requested name when rejoining a running game: mid-game renames are
  // refused server-side (names are the identity key for pushState merging),
  // so the client must adopt the seat's existing name.
  name?: string;
}

export type { ConfigKeys };

/**
 * The device bucket as it stood when this game STARTED, so the end screen can
 * tell a genuine new record from one this very game merely tied.
 *
 * Covers every RECORD_COLUMNS entry the end screen can attribute to one seat.
 * (mostPlayersInGame and longestGameRounds are properties of the game, not of
 * a player, and are already on screen as themselves.)
 */
export type PreGameStats = Pick<DeviceStatsRow,
  | 'highestTurnScore'
  | 'fastestWinTurns'
  | 'fastestLossTurns'
  | 'highestFeuerwerkTurnScore'
  | 'highestX2TurnScore'
  // Classic only: a modernized turn is one card and forfeits nothing.
  | 'mostCardsInTurn'
  | 'highestForfeitedTurnScore'
>;

export interface GameStore extends CoreGameState {
  mode: GameMode;
  deviceId: string | null;
  isOnline: boolean;
  showReconnectPopup: boolean;
  // False from joinRoom until the room's first gameState lands — that sync
  // describes the room as it already is, so the config-diff toasts skip it.
  roomStateSynced: boolean;
  roomId: string | null;
  isHost: boolean;
  hostId: string | null;
  myName: string | null;
  // The `stateVersion` of the newest gameState broadcast this client has
  // applied, and the floor for the next one: a broadcast carrying a LOWER
  // version is a late straggler and is dropped, so it cannot overwrite state
  // this client has already moved past. Client-only — server-derived metadata
  // that is never pushed back (it is deliberately absent from
  // SYNCED_GAME_STATE_KEYS) and never persisted. null means "no floor yet",
  // which is where every join and every leave puts it: a new room's versions
  // start over at zero, and a floor carried across would ignore all of them.
  lastAppliedStateVersion: number | null;
  toasts: Toast[];
  reactions: Reaction[];
  diceMode: DiceMode;
  // Host-only room config: null means every player uses their own diceMode
  // (the default); a DiceMode value pins that mode for everyone's own turn,
  // overriding their personal preference (see Game.tsx's effectiveDiceMode).
  enforcedDiceMode: DiceMode | null;
  // Host-only room config: which rule set the game is played by. See Ruleset
  // in types.ts — synced to every client like the other config fields.
  ruleset: Ruleset;
  audioEnabled: boolean;
  hapticsEnabled: boolean;
  randomOrder: boolean;
  turnDuration: number;
  reconnectTimeout: number;
  turnTimeRemaining: number | null;
  // Epoch ms the current turn expires at, derived from the server's reported
  // remaining time plus Date.now() at the moment it arrived (see
  // syncOnlineTimers in timers.ts). Client-derived — never synced from the
  // server and never persisted — so the display countdown can be recomputed
  // from wall-clock time on every tick instead of decrementing by 1, which
  // drifts once a throttled background tab stops firing interval callbacks.
  turnDeadline: number | null;
  chartValues: number[][];
  chartNames: string[];
  chartLabels: number[];
  status: GameStatus;
  liveTurnState: DiceSnapshot | null;
  justReconnected: boolean;
  pendingReconnectSession?: ReconnectSession | null;
  // Snapshot of this device's lifetime records, fetched once when a game
  // starts — i.e. strictly before this game's own endGameStats submission can
  // land. EndScreen diffs the post-game deviceStats against this to tell a
  // genuinely new personal record apart from merely tying an older one.
  preGameStats: PreGameStats | null;
  // The game as it stood the moment `finished` first went true, kept so the
  // global-stats payload cannot be built over a roster that changed
  // afterwards. It can: with a non-zero reconnectTimeout the host promotion
  // that submits on a dead host's behalf only fires when the disconnect timer
  // drains, and that server callback splices the seat BEFORE it broadcasts —
  // so the promoted client would otherwise sum every counter over the
  // survivors of the game rather than its players.
  finishedGameSnapshot: FinishedGameSnapshot | null;

  reset: () => void;
  clearPendingReconnect: () => void;
  cancelReconnect: (roomId?: string | null, name?: string | null) => void;
  init: (deviceId: string) => void;
  setMode: (mode: GameMode) => void;
  addToast: (message: string) => void;
  removeToast: (id: number) => void;
  sendReaction: (emoji: string) => void;
  removeReaction: (id: number) => void;
  setDiceMode: (val: DiceMode) => void;
  setAudioEnabled: (val: boolean) => void;
  setHapticsEnabled: (val: boolean) => void;
  updateConfig: (config: Partial<Pick<GameStore, ConfigKeys>>) => void;
  setWinningScore: (val: number) => void;
  setInitialCards: (val: InitialCards) => void;
  setRandomOrder: (val: boolean) => void;
  setTurnDuration: (val: number) => void;
  setReconnectTimeout: (val: number) => void;
  setEnforcedDiceMode: (val: DiceMode | null) => void;
  setRuleset: (val: Ruleset) => void;
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
  pushLiveTurnState: (snapshot: DiceSnapshot | null) => void;
  startLocalTimers: () => void;
  stopLocalTimers: () => void;
  syncOnlineTimers: (serverRemaining?: number | null) => void;
  stopOnlineTimers: () => void;
  startGame: () => void;
  endGame: () => void;
  nextTurn: (scoreInput: number, isSuccess?: boolean, turnSummary?: TurnSummary) => void;
  // Classic chains: reveal the next card mid-turn after a tutto. Returns the
  // drawn card (or null when nothing could be drawn).
  drawCardMidTurn: () => CardType | null;
  undo: () => void;
  setPreGameStats: (stats: PreGameStats | null) => void;
  buildGlobalStatsPayload: () => GlobalStatsPayload;
  sendOnlineStats: () => void;
}

// The canonical zustand "slices" helper: a slice creator gets the same
// set/get the composed store was built with (immer middleware included), and
// returns just its own subset of GameStore actions.
export type ImmerStateCreator<T> = StateCreator<GameStore, [['zustand/immer', never]], [], T>;
