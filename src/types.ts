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

// Which rule set a game is played by. 'modernized' is the app's original
// house-ruled behavior (a completed card ends the turn); 'classic' follows the
// official Abacusspiele rules (after a tutto the player may reveal another
// card and keep going, risking everything). Host-owned room config, synced
// and frozen at game start like the stats mode.
export type Ruleset = 'modernized' | 'classic';

// Which bucket a finished game's statistics land in — the ruleset picks the
// pair ('normalized'/'custom' = modernized, kept unrenamed for backward
// compatibility with stored rows and old clients; 'classic'/'classic_custom' =
// classic), and isNormalizedConfig (utils/configValidation.ts) picks within
// it. Doubles as a stored column value (device_statistics.mode) and as an API
// query parameter, so GAME_MODES below is what validates an untrusted string.
export type GameMode = 'normalized' | 'custom' | 'classic' | 'classic_custom';

export const GAME_MODES: readonly GameMode[] = ['normalized', 'custom', 'classic', 'classic_custom'];

// What every caller that doesn't say otherwise means: the statistics as they
// were understood before custom games got their own bucket.
export const DEFAULT_GAME_MODE: GameMode = 'normalized';

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
  // The turn is decided and banked (Stop & Score, a modernized turn-ending
  // tutto, a completed Kleeblatt), showing its success summary. A restore
  // must land back in that summary — not in a dice table where the decision
  // could be rolled back. The server turn timer also reads it: a timeout on
  // a banked decision forfeits as 'timeout', never as a rolled null.
  // Mirrored in server/pushValidation.ts's snapshot family like `busted`.
  stopped?: boolean;
  // Classic-chain progress (absent in modernized turns): the cards drawn this
  // turn in order, the Plus/Minus cards succeeded so far (see plusMinusScores
  // on TurnSummary for what the numbers are), and the total tuttos rolled
  // (unlike tuttosThisTurn above, never reset by a Kleeblatt draw). Mirrored
  // in server/pushValidation.ts's snapshot family — a field missing there is
  // silently stripped from every relayed snapshot.
  cardsThisTurn?: CardType[];
  plusMinusScores?: number[];
  chainTuttoCount?: number;
}

// Sanity cap for classic-chain card lists (snapshot, history, turn summary) —
// far beyond any real chain, just enough to bound what a pushed payload can
// make the server store and rebroadcast.
export const MAX_CHAIN_CARDS = 100;

// How a classic turn ended: banked its points (includes the Feuerwerk null,
// which banks), rolled a null, drew a Stop card mid-chain, or had the server
// turn timer expire with the current card already completed ('timeout' — the
// turn forfeits, but no null was rolled, so it must not count as a bust; only
// server/turnTimers.ts ever produces it).
//
// The type is DERIVED from the list rather than declared beside it: three
// validators (the local save, the physical-turn cache, the pushed state) have
// to recognise these values at runtime, and they used to re-enumerate them by
// hand — so a fifth kind would have type-checked everywhere while being
// silently rejected by all three. Now there is one list to add it to.
export const TURN_ENDS = ['banked', 'null', 'stopCard', 'timeout'] as const;
export type TurnEnd = typeof TURN_ENDS[number];

export interface TurnCardPlayed {
  card: CardType;
  // Whether the card's own goal was reached (tutto / straight / Plus-Minus
  // success / Feuerwerk banked). Every card before the last is completed by
  // definition — the chain only continues on a completion.
  completed: boolean;
}

// What happened during one classic turn, card by card. Built by the client
// that played the turn and passed to calculateNextTurn, whose classic path
// derives every per-card counter from it (the score arrives fully computed:
// straight +2000, Plus/Minus +1000 per success, bonus/x2 already applied).
// Its very presence is what switches the engine to classic semantics.
export interface TurnSummary {
  cards: TurnCardPlayed[];
  tuttoCount: number;
  // One entry per successful Plus/Minus, in the order the chain played them,
  // each holding the turn total the player ALREADY held when that card
  // resolved — before its own +1000. The engine replays the ±1000s card by
  // card against these, so a chain that overtakes the leader partway through
  // stops deducting from that point on; a bare count could only ever compare
  // against the pre-turn score and kept deducting past the lead change.
  plusMinusScores: number[];
  ended: TurnEnd;
  // The accumulated total that was on the table when a null/Stop ended the
  // turn — feeds the highestForfeitedTurnScore record. Absent when banked.
  forfeitedScore?: number;
  // Filled by the ENGINE at commit (one entry per deduction — names repeat
  // when several Plus/Minus successes hit the same leader) so undo can
  // reverse times1000PointsDeducted per occurrence.
  deductedPlayers?: string[];
  // Also engine-filled: the player's classic records BEFORE this turn, so
  // undo can restore them without another round of previous* plumbing.
  // null = the player had no value yet.
  prevMostCardsInTurn?: number | null;
  prevHighestForfeitedTurnScore?: number | null;
}

export interface Player {
  // Stable per-player identity, minted once at creation (client
  // createInitialPlayer / server joinRoom) and carried through every reset
  // (startGame) and merge (server pushValidation). Currently used only for
  // React keys — every name-keyed lookup (Plus/Minus deduction, undo,
  // pushState merging, reorderPlayers) is unchanged and still matches by
  // name; see the Player.id staging notes in implementation_plan.md for why
  // migrating those is its own, larger follow-up. Optional (not every
  // in-memory Player literal across the codebase sets one, e.g. test
  // fixtures and old localStorage saves) — callers that render a key from it
  // fall back to `name` when absent.
  id?: string;
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
  // Tuttos rolled, counted from classic turn summaries (a modernized turn
  // carries no summary, so the modernized buckets never display it).
  totalTuttos: number;
  position: number;
  color?: string;
  socketId?: string;
  deviceId?: string;
  disconnected?: boolean;
  highestTurnScore?: number;
  highestFeuerwerkTurnScore?: number;
  highestX2TurnScore?: number;
  // Classic-chain records — like the maxima above, "no turn yet" is
  // undefined, not zero, so they are not part of the zeroed stat set.
  mostCardsInTurn?: number;
  highestForfeitedTurnScore?: number;
  winStreak?: number;
  // The classic bucket's streak, fetched alongside winStreak on join — the
  // badge shows whichever matches the room's ruleset.
  winStreakClassic?: number;
}

export type HistoryEventType = 'success' | 'bust' | 'skip' | 'fail';

export interface HistoryEntry {
  id: string;
  round: number;
  playerName: string;
  playerColor?: string;
  card: CardType;
  type: HistoryEventType;
  score: number;
  deductedPlayers?: string[];
  // Classic chains only: every card of the turn in draw order (card above is
  // the first of them). Mirrored in server/pushValidation.ts's history-entry
  // family — a field missing there never reaches the other clients.
  cards?: CardType[];
}

export const MAX_HISTORY_LOG_SIZE = 50;

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
  // Whether the previous turn succeeded, recorded at commit rather than
  // re-derived by undo. The score alone cannot tell a FAILED Kniffel or
  // Plus/Minus apart from a completed one: a completion is worth exactly the
  // card's fixed value, and a failure committed with that same value read as
  // a completion — so the failure counter was never reversed.
  //
  // Optional because absent is the only thing that distinguishes a save (or a
  // push from a client) predating this field from a recorded `false`; those
  // fall back to the score comparison they were committed under, see
  // calculateUndo.
  previousWasSuccess?: boolean;
  previousHighestTurnScore: number;
  previousHighestFeuerwerkTurnScore: number;
  previousHighestX2TurnScore: number;
  // Name of the player who took the previous (undoable) turn. Undo looks this
  // player up by name rather than by "currentPlayerIndex - 1" — the roster can
  // shift (mid-game leave/kick/reconnect-timeout) between that turn and now, so
  // an index computed against the CURRENT roster would land on whoever now
  // happens to occupy that slot instead of the player who actually played it.
  previousPlayerName: string | null;
  // The classic-turn summary the previous turn committed with, or null for a
  // modernized turn (and for timeouts). Undo needs it to reverse per-card
  // counters and restore every chain card to the deck.
  previousTurnSummary: TurnSummary | null;
  finished: boolean;
  gameStartTime: number | null;
  gameTimeInSeconds: number;
  historyLog: HistoryEntry[];
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
  totalPlayersSum: number;
  mostPlayersInGame: number;
  totalRoundsSum: number;
  longestGameRounds: number;
  highestFeuerwerkTurnScore: number;
  highestX2TurnScore: number;
  totalTuttos: number;
  mostCardsInTurn: number | null;
  highestForfeitedTurnScore: number | null;
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
  // Always produced here (unlike CoreGameState, where an old save may lack it).
  previousWasSuccess: boolean;
  previousHighestTurnScore: number;
  previousHighestFeuerwerkTurnScore: number;
  previousHighestX2TurnScore: number;
  previousPlayerName: string;
  previousTurnSummary: TurnSummary | null;
  newDeck: CardType[];
  drawnCard: CardType | null;
  historyEntry: HistoryEntry;
}

export interface UndoResult {
  players: Player[];
  nextIndex: number;
  nextRound: number;
  isRoundEndUndo: boolean;
  newDeck: CardType[];
  drawnCard: CardType;
}
