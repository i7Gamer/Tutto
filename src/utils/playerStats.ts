import type { Player } from '../types';

// Every number a player starts a game on. Written out once, because three
// places need the same list and nothing made them agree: the client creates
// players (gameSlice.ts), the server creates them for an online room
// (socketHandlers.ts), and the server decides which of their fields a client
// is allowed to write back (pushValidation.ts).
//
// The third one is where forgetting hurts. A gameState broadcast replaces the
// roster wholesale, so a counter the server will not accept back is not
// merely ignored — it is reset after every turn, for the whole room, silently.
// That is exactly what happened to the per-turn maxima.
//
// `satisfies` rather than a type annotation: it checks every key against
// Player without widening the object, so the field names below stay available
// to derive PLAYER_STAT_FIELDS from.
const ZEROED_PLAYER_STATS = {
  score: 0,
  times1000PointsDeducted: 0,
  timesKniffelCompleted: 0,
  timesPlusMinusCompleted: 0,
  timesKniffelFailed: 0,
  timesKleeblattFailed: 0,
  timesKleeblattCompleted: 0,
  timesPlusMinusFailed: 0,
  timesFeuerwerkReceived: 0,
  timesSkipped: 0,
  timesx2Received: 0,
  totalTurns: 0,
  busts: 0,
  feuerwerkBusts: 0,
  x2Busts: 0,
  feuerwerkPointsScored: 0,
  x2PointsScored: 0,
  totalTuttos: 0,
} satisfies Partial<Player>;

export type PlayerStats = typeof ZEROED_PLAYER_STATS;
export type PlayerStatField = keyof PlayerStats;

/** The names of those fields, for anything that has to enumerate them. */
export const PLAYER_STAT_FIELDS = Object.keys(ZEROED_PLAYER_STATS) as PlayerStatField[];

/**
 * The per-turn records, which are numbers but NOT part of the set above.
 *
 * A player does not start a game on a maximum — "no value yet" is undefined,
 * not zero — so they are deliberately absent from ZEROED_PLAYER_STATS, and
 * anything deriving a numeric-field list from it silently excluded them. That
 * is how a corrupted local save could restore one as a string: the save
 * validator checked PLAYER_STAT_FIELDS and then let any string through its
 * generic fallback. A string record can never be beaten (5000 > "99999" is
 * false), so it sticks for the rest of the game and renders verbatim.
 *
 * `satisfies` for the same reason as above: every name is checked against
 * Player, so a renamed field fails to compile rather than falling out of the
 * list.
 */
const PLAYER_RECORD_FIELD_MAP = {
  highestTurnScore: 0,
  highestFeuerwerkTurnScore: 0,
  highestX2TurnScore: 0,
  mostCardsInTurn: 0,
  highestForfeitedTurnScore: 0,
} satisfies Partial<Player>;

export type PlayerRecordField = keyof typeof PLAYER_RECORD_FIELD_MAP;

/** The per-turn record names, for anything that has to enumerate them. */
export const PLAYER_RECORD_FIELDS = Object.keys(PLAYER_RECORD_FIELD_MAP) as PlayerRecordField[];

/** Every player field that must be a number when present: counters and records. */
export const PLAYER_NUMERIC_FIELDS: (PlayerStatField | PlayerRecordField)[] =
  [...PLAYER_STAT_FIELDS, ...PLAYER_RECORD_FIELDS];

/** A fresh set — never the shared object, which every player would then share. */
export const zeroedPlayerStats = (): PlayerStats => ({ ...ZEROED_PLAYER_STATS });

// The win-streak length that earns a player the 🔥 badge — shared by the
// lobby roster (LobbyShared.tsx), the in-game scoreboard (Game.tsx) and the
// statistics page's own streak highlight, so the three can never disagree on
// what counts as "hot".
export const HOT_WIN_STREAK = 3;
