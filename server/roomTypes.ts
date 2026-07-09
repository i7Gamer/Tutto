import type { CardType, InitialCards, Player, DiceSnapshot, DiceMode, HistoryEntry } from '../src/types';

// CardType / InitialCards / Player are shared with the client (src/types.ts) to
// keep the card set and player shape from drifting. The server requires the
// connection fields the client treats as optional, so narrow them here.
export type ServerPlayer = Omit<Player, 'deviceId' | 'socketId' | 'color' | 'disconnected'> & {
  deviceId: string;
  socketId: string;
  color: string;
  disconnected: boolean;
};

export interface RoomState {
  players: ServerPlayer[];
  status: 'lobby' | 'playing';
  initialCards: InitialCards;
  winningScore: number;
  randomOrder: boolean;
  turnDuration: number;
  reconnectTimeout: number;
  currentCard: CardType | null;
  cards: CardType[];
  round: number;
  currentPlayerIndex: number | null;
  finished: boolean;
  chartValues: number[][];
  chartNames: string[];
  chartLabels: number[];
  gameTimeInSeconds: number;
  turnStartTime: number | null;
  previousCard: CardType | null;
  previousScore: number | null;
  previousLeaders: ServerPlayer[] | null;
  previousWasBust: boolean;
  previousHighestTurnScore: number;
  previousHighestFeuerwerkTurnScore: number;
  previousHighestX2TurnScore: number;
  // Name of the player who took the previous turn — see CoreGameState in
  // src/types.ts for why undo keys off this instead of a roster index.
  previousPlayerName: string | null;
  liveTurnState: DiceSnapshot | null;
  // null = every player uses their own diceMode; a DiceMode value = the host
  // has pinned that mode for everyone's own turn. Host-only config.
  enforcedDiceMode: DiceMode | null;
  historyLog: HistoryEntry[];
}

export interface TurnTimerState {
  lastCard: CardType | null;
  lastPlayerIndex: number | null;
}

// Tracks which devices/global stats have already been recorded for the room's
// CURRENT game — reset whenever a new game starts (see pushState's startingGame
// branch). Without this, a player who reconnects or reloads after their game
// already finished (but before leaving the room) re-triggers their client's
// "finished just became true" stats submission on every reconnect, repeatedly
// inflating both their device stats and, if they're host, the global stats.
export interface StatsRecordedForGame {
  devices: Set<string>;
  global: boolean;
}

export interface Room {
  host: string;
  state: RoomState;
  gameActualStartTime: number | null;
  turnTimerState: TurnTimerState | null;
  disconnectTimers: Record<string, ReturnType<typeof setTimeout>>;
  turnExpireTimer: ReturnType<typeof setTimeout> | null;
  statsRecordedForGame: StatsRecordedForGame;
}
