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
} satisfies Partial<Player>;

export type PlayerStats = typeof ZEROED_PLAYER_STATS;
export type PlayerStatField = keyof PlayerStats;

/** The names of those fields, for anything that has to enumerate them. */
export const PLAYER_STAT_FIELDS = Object.keys(ZEROED_PLAYER_STATS) as PlayerStatField[];

/** A fresh set — never the shared object, which every player would then share. */
export const zeroedPlayerStats = (): PlayerStats => ({ ...ZEROED_PLAYER_STATS });
