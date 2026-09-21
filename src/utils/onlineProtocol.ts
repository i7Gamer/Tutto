import type {
  AcceptedDrawReceipt,
  CoreGameState,
  DiceMode,
  DiceSnapshot,
  DrawCardAck,
  InitialCards,
  JoinRoomResponse,
  OnlineGameAction,
  PushStateAck,
  Reaction,
  Ruleset,
  StatsSubmitAck,
} from '../types';

// Version 2 replaces the online ordered deck with public composition and
// identifies gameplay actions. Cached version-1 clients must refresh/rejoin.
export const ONLINE_PROTOCOL_VERSION = 2;

export interface JoinRoomRequest {
  roomId: string;
  name: string;
  deviceId: string | null;
  color?: string | null;
  initialConfig?: OnlineConfigPatch;
  isReconnect?: boolean;
}

export interface PushStateRequest {
  roomId: string;
  base: string;
  mutationId: string;
  action: OnlineGameAction;
  newState: Record<string, unknown>;
}

export interface LiveTurnStateRequest {
  roomId: string;
  base: string;
  liveTurnState: DiceSnapshot | null;
}

export interface DrawCardRequest {
  roomId: string;
  base: string;
  drawId: string;
}

export interface OnlineConfigFields {
  winningScore: number;
  initialCards: InitialCards;
  randomOrder: boolean;
  turnDuration: number;
  reconnectTimeout: number;
  enforcedDiceMode: DiceMode | null;
  ruleset: Ruleset;
}

export type OnlineConfigPatch = Partial<OnlineConfigFields>;

export type UpdateConfigRequest = OnlineConfigPatch & { roomId: string };

export interface ReorderPlayersRequest {
  roomId: string;
  newPlayers: { name: string }[];
}

export interface UpdatePlayerColorRequest {
  roomId: string;
  color: string;
}

export interface EndGameStatsRequest {
  deviceId: string;
  finishedGameToken?: string;
}

export interface SubmitGlobalStatsRequest {
  finishedGameToken?: string;
}

export interface PublicGameStateFields extends Omit<CoreGameState, 'cards' | 'gameStartTime'>, OnlineConfigFields {
  status: 'lobby' | 'playing';
  remainingCardCounts: InitialCards | null;
  chartValues: number[][];
  chartNames: string[];
  chartLabels: number[];
  liveTurnState: DiceSnapshot | null;
}

export type GameStateBroadcast = Partial<PublicGameStateFields> & {
  roomId?: string;
  stateVersion?: number;
  turnTimeRemaining?: number | null;
  gameplayToken?: string;
  finishedGameToken?: string | null;
  acceptedDraw?: AcceptedDrawReceipt | null;
  stateRequestId?: string;
};

export interface ServerToClientEvents {
  gameState: (state: GameStateBroadcast) => void;
  hostId: (hostSocketId: string | null) => void;
  playerDisconnected: (name: string | null) => void;
  nameConflictWithDisconnected: (name: string) => void;
  playerReaction: (reaction: Reaction) => void;
  liveTurnState: (payload: { liveTurnState: DiceSnapshot | null }) => void;
  kicked: () => void;
  seatTakenOver: () => void;
  gameAborted: () => void;
}

export interface ClientToServerEvents {
  joinRoom: (payload: JoinRoomRequest, callback: (result: JoinRoomResponse) => void) => void;
  updateConfig: (payload: UpdateConfigRequest) => void;
  reorderPlayers: (payload: ReorderPlayersRequest) => void;
  updatePlayerColor: (payload: UpdatePlayerColorRequest) => void;
  kickPlayer: (targetSocketId: string) => void;
  sendReaction: (payload: { emoji: string }) => void;
  leaveRoom: () => void;
  pushState: (payload: PushStateRequest, ack?: (result?: PushStateAck) => void) => void;
  liveTurnState: (payload: LiveTurnStateRequest) => void;
  drawCard: (payload: DrawCardRequest, ack?: (result?: DrawCardAck) => void) => void;
  requestState: (payload: { roomId: string; requestId?: string }) => void;
  endGameStats: (payload: EndGameStatsRequest, ack?: (result?: StatsSubmitAck) => void) => void;
  submitGlobalStats: (payload: SubmitGlobalStatsRequest, ack?: (result?: StatsSubmitAck) => void) => void;
}

export interface ServerIngressEvents {
  joinRoom: (
    payload: {
      roomId?: string;
      name?: string;
      deviceId?: string;
      color?: string;
      initialConfig?: Record<string, unknown>;
      isReconnect?: boolean;
    } | null | undefined,
    callback: (result: JoinRoomResponse & { socketId?: string; code?: string }) => void,
  ) => void;
  updateConfig: (payload: {
    roomId?: string;
    winningScore?: number;
    initialCards?: unknown;
    randomOrder?: boolean;
    turnDuration?: number;
    reconnectTimeout?: number;
    enforcedDiceMode?: DiceMode | null;
    ruleset?: unknown;
  } | null | undefined) => void;
  reorderPlayers: (payload: { roomId?: string; newPlayers?: { name: string }[] } | null | undefined) => void;
  updatePlayerColor: (payload: { roomId?: string; color?: string } | null | undefined) => void;
  kickPlayer: (targetSocketId: unknown) => void;
  sendReaction: (payload: { emoji?: string } | null | undefined) => void;
  leaveRoom: () => void;
  pushState: (
    payload: {
      roomId?: string;
      newState?: Record<string, unknown>;
      base?: unknown;
      mutationId?: unknown;
      action?: unknown;
    } | null | undefined,
    ack?: (result: PushStateAck) => void,
  ) => void;
  liveTurnState: (payload: { roomId?: string; base?: unknown; liveTurnState?: unknown } | null | undefined) => void;
  drawCard: (
    payload: { roomId?: string; base?: unknown; drawId?: unknown } | null | undefined,
    ack?: (result: DrawCardAck) => void,
  ) => void;
  requestState: (payload: { roomId?: string; requestId?: unknown } | null | undefined) => void;
  endGameStats: (
    payload: { deviceId?: string; stats?: unknown; finishedGameToken?: string } | null | undefined,
    ack?: (result: StatsSubmitAck) => void,
  ) => void;
  submitGlobalStats: (
    payload: { roomId?: string; payload?: unknown; finishedGameToken?: string } | null | undefined,
    ack?: (result: StatsSubmitAck) => void,
  ) => void;
}

export type OnlineServerEmitEvent = keyof ServerToClientEvents;
export type OnlineClientEmitEvent = keyof ClientToServerEvents;
export type OnlineServerIngressEvent = keyof ServerIngressEvents;
