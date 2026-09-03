import type { CardType, InitialCards, Player, DiceSnapshot, DiceMode, GameMode, HistoryEntry, Ruleset, TurnSummary, SyncedGameStateKey, AssertNever } from '../src/types';

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

// Fields only the server acts on. They DO ride the gameState broadcast —
// emitRoomState spreads the whole room state — but every client drops them
// on arrival (GAME_STATE_SYNC_KEYS is the applied-field allowlist), and a
// push may never write them.
type ServerOnlyRoomField = 'turnStartTime';

// Compile-time lock between RoomState and the canonical synced-field list
// (SYNCED_GAME_STATE_KEYS, src/types.ts). Exported only so noUnusedLocals
// sees a use; nothing imports it. If either side gains a field the other
// does not account for, the build fails naming the key — so adding a field
// here forces a decision in every list the canonical one anchors (the
// src/types.ts comment lists them all).
export type RoomStateFieldLock = [
  // Every RoomState field is either synced or declared server-only.
  AssertNever<Exclude<keyof RoomState, SyncedGameStateKey | ServerOnlyRoomField>>,
  // Every synced field actually exists on RoomState.
  AssertNever<Exclude<SyncedGameStateKey, keyof RoomState>>,
  // Server-only names are real RoomState fields (typo guard) …
  AssertNever<Exclude<ServerOnlyRoomField, keyof RoomState>>,
  // … and are not simultaneously synced.
  AssertNever<Extract<ServerOnlyRoomField, SyncedGameStateKey>>,
];

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
  /**
   * How much of each device's row for the CURRENT game is already written.
   *
   * Membership alone is the dedup every path shares; the LEVEL is what tells
   * the server's own departed-seat write apart from a device recording its
   * own game in full. See DeviceStatsRecordLevel.
   */
  devices: Map<string, DeviceStatsRecordLevel>;
  global: boolean;
}

/**
 * How complete a device's statistics row for the current game is.
 *
 * 'verdict-only' — the SERVER wrote the row (recordDepartedSeatsStats in
 * rooms.ts) for a seat that had left or was disconnected when the finish was
 * broadcast: the game and its outcome, and nothing else. The device's own
 * later submission (it reconnected after all) is still owed everything that
 * row could not know, so endGameStats merges it in rather than refusing it as
 * a duplicate.
 *
 * 'full' — a complete row is in, from the seat's own endGameStats. Any
 * further submission for the same game is a no-op.
 */
export type DeviceStatsRecordLevel = 'verdict-only' | 'full';

/**
 * The result of a finished game, as the room saw it at the moment it ended.
 *
 * A client decides "did I win" with getLeaders() over its own roster — which
 * is wrong for any client whose first sight of the finish arrives after a seat
 * has left, because the last player standing then looks like the leader. The
 * damage is permanent (fastestWinTurns is a MIN column, the win streak only
 * rises), so the verdict is the server's, taken while the winner was still
 * seated — the same reasoning that makes isDefaultGame the server's call.
 */
export interface FinishedGame {
  /**
   * Every tied leader, by name — see getLeaders.
   *
   * In practice always exactly one: a tie is not a win, so no path to
   * `finished` can produce more. pushValidation's `applyFinished` holds every
   * pusher, the host included, to the engine's sole-leader rule, and the two
   * server-side finishes (turnTimers' expiry, rooms' handleActivePlayerRemoved)
   * run the same check themselves. The plural stays because getLeaders returns
   * a list and a downstream reader must not assume the shape it was handed.
   */
  winners: string[];
  /**
   * Seats at the table when the game ended, for the players-per-game totals —
   * every seat that was there at kickoff (room.startRoster's length when one
   * was captured), not merely whoever is still seated at the finish. A seat
   * that left, was kicked, or timed out before the finish still played the
   * game and must still count.
   */
  playerCount: number;
}

/** One seat's identity at the moment the CURRENT game started. */
export interface StartRosterEntry {
  deviceId: string;
  name: string;
}

export interface Room {
  host: string;
  /**
   * Monotonic counter of this room's broadcasts, bumped once per gameState
   * emitRoomState sends and carried on the payload.
   *
   * Ordering metadata, not game state — which is why it lives on Room rather
   * than RoomState: it is never pushable (a client that sends it is ignored,
   * the same as any unknown key), never part of SYNCED_GAME_STATE_KEYS, and
   * the client keeps it in a client-only field of its own
   * (lastAppliedStateVersion). What it buys is a floor: a broadcast that
   * overtakes a newer one can be recognised and dropped instead of silently
   * reverting state the receiving client has already moved past.
   */
  stateVersion: number;
  // The client address this room was created from, for the per-address
  // creation cap (countRoomsCreatedBy). '' means it was not attributed to
  // any client — a room seeded directly by a test.
  createdBy: string;
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
  // Who actually won the CURRENT game, and how many were at the table when it
  // ended — frozen the first moment the room reports it over, and the value
  // endGameStats trusts instead of the verdict the submitting client computed.
  // null while no game is finished. See rememberFinishedGame in rooms.ts.
  finishedGame: FinishedGame | null;
  // Every seat's deviceId + name at the moment the CURRENT game started —
  // captured in socketGameStateHandlers' pushState, the same place that
  // freezes normalizedGame/ruleset, and reset the same way on the next game
  // (lobby->playing or Play Again's finished->playing). null until a game has
  // actually started under this Room object. A start-roster entry with no
  // matching seat left in room.state.players by the time the game ends left
  // BEFORE the finish and is invisible to endGameStats — see
  // recordDepartedSeatsStats in rooms.ts, which records it instead.
  startRoster: StartRosterEntry[] | null;
}

/**
 * Which device-statistics bucket a game with this ruleset/normalizedGame
 * combination belongs in. The ruleset picks the bucket PAIR, normalizedGame
 * picks within it — shared by endGameStats (the submitting seat's own
 * write) and the server's own departed-seat write (recordDepartedSeatsStats
 * in rooms.ts), so the two can never disagree about where the same game's
 * rows land.
 */
export const statsModeFor = (room: Pick<Room, 'ruleset' | 'normalizedGame'>): GameMode =>
  room.ruleset === 'classic'
    ? (room.normalizedGame ? 'classic' : 'classic_custom')
    : (room.normalizedGame ? 'normalized' : 'custom');
