export type CardType =
  | 'Kleeblatt'
  | 'Feuerwerk'
  | 'Stop'
  | 'Kniffel'
  | 'Plus_Minus'
  | 'x2'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600';

export type InitialCards = Partial<Record<CardType, number>>;

export type DiceMode = 'physical' | 'digital';

export interface Die {
  id: string;
  val: number;
  selected?: boolean;
}

export interface SnapshotDie {
  id: string;
  val: number;
}

export interface DiceSnapshot {
  turnScore: number;
  keptDice: SnapshotDie[];
  currentRoll: (SnapshotDie & { selected: boolean })[];
  kniffelProgress: number[];
  tuttosThisTurn: number;
  busted?: boolean;
  rollingDiceIds?: string[];
  playerName?: string;
  // Identifies which turn this localStorage-persisted snapshot belongs to (see
  // buildTurnKey in diceTurnState.ts) — lets DiceGame tell a same-player-but-
  // expired-turn snapshot apart from a genuinely resumable one.
  turnKey?: string;
}

export interface Player {
  name: string;
  score: number;
  times1000PointsDeducted: number;
  timesKniffelCompleted: number;
  timesPlusMinusCompleted: number;
  timesKniffelFailed: number;
  timesKleeblattFailed: number;
  timesKleeblattCompleted: number;
  timesPlusMinusFailed: number;
  timesFeuerwerkReceived: number;
  timesSkipped: number;
  timesx2Received: number;
  totalTurns: number;
  busts: number;
  feuerwerkBusts: number;
  x2Busts: number;
  feuerwerkPointsScored: number;
  x2PointsScored: number;
  position: number;
  color?: string;
  socketId?: string;
  deviceId?: string;
  disconnected?: boolean;
  highestTurnScore?: number;
  winStreak?: number;
}

export interface CoreGameState {
  players: Player[];
  currentPlayerIndex: number | null;
  currentCard: CardType | null;
  round: number;
  winningScore: number;
  cards: CardType[];
  initialCards: InitialCards;
  previousCard: CardType | null;
  previousScore: number | null;
  previousLeaders: Player[] | null;
  previousWasBust: boolean;
  previousHighestTurnScore: number;
  // Name of the player who took the previous (undoable) turn. Undo looks this
  // player up by name rather than by "currentPlayerIndex - 1" — the roster can
  // shift (mid-game leave/kick/reconnect-timeout) between that turn and now, so
  // an index computed against the CURRENT roster would land on whoever now
  // happens to occupy that slot instead of the player who actually played it.
  previousPlayerName: string | null;
  finished: boolean;
  gameStartTime: number | null;
  gameTimeInSeconds: number;
}

export interface Toast {
  id: number;
  message: string;
}

export interface Reaction {
  id: number;
  emoji: string;
  senderName: string;
  senderColor?: string | null;
}

export interface GlobalStatsPayload {
  gamesPlayed: number;
  totalPlaytime: number;
  totalPlusMinus: number;
  totalKniffel: number;
  totalStop: number;
  totalFeuerwerk: number;
  totalKleeblatt: number;
  totalKleeblattCompleted: number;
  totalx2: number;
  totalTurns: number;
  totalScore: number;
  totalPlusMinusCompleted: number;
  totalKniffelCompleted: number;
  totalFeuerwerkPoints: number;
  totalx2Points: number;
  totalFeuerwerkBusts: number;
  totalx2Busts: number;
  totalBusts: number;
  highestTurnScore: number;
  fastestWinTurns: number | null;
  fastestLossTurns: number | null;
  isDefaultGame: boolean;
}

export interface NextTurnResult {
  players: Player[];
  isGameOver: boolean;
  isRoundEnd: boolean;
  nextIndex: number | null;
  nextRound: number;
  previousCard: CardType | null;
  previousScore: number;
  previousLeaders: Player[] | null;
  previousWasBust: boolean;
  previousHighestTurnScore: number;
  previousPlayerName: string;
  newDeck: CardType[];
  drawnCard: CardType | null;
}

export interface UndoResult {
  players: Player[];
  nextIndex: number;
  nextRound: number;
  isRoundEndUndo: boolean;
  newDeck: CardType[];
  drawnCard: CardType;
}
