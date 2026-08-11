import type { CardType, InitialCards, Player, DiceSnapshot, DiceMode, HistoryEntry, Ruleset, TurnSummary } from '../src/types';

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
  // Optional for the same reason as CoreGameState's (src/types.ts): a push
  // from a client predating the field leaves it unset, and undo falls back to
  // the score comparison such a turn was committed under.
  previousWasSuccess?: boolean;
  previousHighestTurnScore: number;
  previousHighestFeuerwerkTurnScore: number;
  previousHighestX2TurnScore: number;
  // Name of the player who took the previous turn — see CoreGameState in
  // src/types.ts for why undo keys off this instead of a roster index.
  previousPlayerName: string | null;
  // The classic-turn summary the previous turn committed with (undo input),
  // null for modernized turns and timeouts. See TurnSummary in src/types.ts.
  previousTurnSummary: TurnSummary | null;
  liveTurnState: DiceSnapshot | null;
  // null = every player uses their own diceMode; a DiceMode value = the host
  // has pinned that mode for everyone's own turn. Host-only config.
  enforcedDiceMode: DiceMode | null;
  // Which rule set the game is played by. Host-only config, lobby-only:
  // applyPushedState refuses mid-game writes (a rules flip under an active
  // game would desync every client's turn logic).
  ruleset: Ruleset;
  historyLog: HistoryEntry[];
}

export interface TurnTimerState {
  lastCard: CardType | null;
  lastPlayerIndex: number | null;
  // Deck size at the last timer restart. The card VALUE cannot distinguish a
  // classic mid-chain draw of the same card type from no draw at all — the
  // deck shrinking is what tells a real draw apart (the same trick Game.tsx's
  // Stop-buzzer effect uses for consecutive Stop cards).
  lastDeckSize: number | null;
  // Deck-triggered restarts granted within the current player's turn (a new
  // player always resets it). Bounds how long a patched active player can
  // keep their own turn alive by pushing deck changes.
  restartsThisTurn: number;
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
  // Whether the CURRENT game counts toward the statistics — decided by the
  // server from the config the game actually started with, never from the
  // flag the submitting client sends. Set when a game starts and only ever
  // downgraded from there (see socketGameStateHandlers' pushState).
  normalizedGame: boolean;
  // The rule set the CURRENT game actually started with — frozen at kickoff
  // like normalizedGame, and the value the stats handlers trust (never the
  // submitting client's claim). state.ruleset can't change mid-game either,
  // but the freeze makes the stats decision independent of that guard.
  ruleset: Ruleset;
}
