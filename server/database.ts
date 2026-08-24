import knexLib from 'knex';
import type { Knex } from 'knex';
import knexConfig from './knexfile';
import { DEFAULT_GAME_MODE, type GameMode, type Ruleset } from '../src/types';
import { DEFAULT_RULESET } from '../src/utils/configValidation';

const knex = knexLib(knexConfig);

// Callers (server/index.ts in production, individual test files in TEST_DB
// mode) are responsible for awaiting this before the server accepts traffic
// or a test touches the database — it is intentionally not run as an
// import-time side effect so startup can't race ahead of migrations.
/**
 * knex's own wording when knex_migrations records a migration the running
 * build does not ship. That is exactly what downgrading the image while
 * keeping the /data volume produces, and `restart: unless-stopped` then loops
 * the container on it forever — with "Failed to run database migrations" as
 * the only clue.
 */
const MISSING_MIGRATIONS_MARKER = 'migration directory is corrupt';

const DOWNGRADE_HINT = [
  'The database has been migrated by a NEWER version of Tutto than this image.',
  'Downgrading past a migration is not supported: the schema cannot be moved',
  'back, so the old build cannot read it. Either re-pull the newer image tag,',
  'or restore the backup taken before the upgrade (see "Data and backups" in',
  'the README).',
].join(' ');

export const initDb = async (): Promise<void> => {
  try {
    await knex.migrate.latest();
    console.log('Database migrated to the latest version.');
  } catch (err) {
    console.error('Failed to run database migrations:', err);
    // Matched on knex's message rather than an error code, which it does not
    // set — so a knex rewording turns this back into the generic failure
    // above rather than swallowing anything.
    if (err instanceof Error && err.message.includes(MISSING_MIGRATIONS_MARKER)) {
      console.error(DOWNGRADE_HINT);
    }
    throw err;
  }
};

// Drains the connection pool so an in-flight write finishes before the process
// exits (see server/shutdown.ts). Deliberately untested: the knex instance is
// module-level, so destroying it in one suite would break every other suite
// sharing the worker.
export const closeDb = async (): Promise<void> => {
  await knex.destroy();
};

// A nullable-safe MAX/MIN merge expression, shared by updateDeviceStats'
// onConflict.merge() (where the incoming value is referenced as
// `EXCLUDED.col`) and updateGlobalStats' plain update() (where it's a bound
// `?` parameter, repeated once per occurrence below). sqlite's scalar
// MAX(x, NULL)/MIN(x, NULL) is NULL, so without the explicit NULL branches a
// null in the incoming payload would silently wipe the stored best-so-far.
const nullSafeExtreme = (agg: 'MAX' | 'MIN', table: string, col: string, newValueSql: string): string => `
  CASE
    WHEN ${newValueSql} IS NULL THEN ${table}.${col}
    WHEN ${table}.${col} IS NULL THEN ${newValueSql}
    ELSE ${agg}(${table}.${col}, ${newValueSql})
  END
`;

/**
 * The best-ever columns, and which direction "best" runs in.
 *
 * Both scopes keep the same records: `device_statistics` per device and mode,
 * `global_statistics` per ruleset. The two update paths below used to carry
 * their own copy of this list, which meant a column added to one and forgotten
 * in the other silently stopped being a record there — the same way a stat
 * missing from PLAYER_STAT_FIELDS (src/utils/playerStats.ts) silently stopped
 * being kept. One list, read by both, and the tests generate their cases from
 * it so a new column arrives already covered in both scopes.
 *
 * Every one is nullable, NULL meaning "no record yet" — hence nullSafeExtreme
 * above rather than a bare MAX/MIN, whose sqlite result against NULL is NULL.
 */
export const RECORD_COLUMNS: readonly [col: string, agg: 'MAX' | 'MIN'][] = [
  ['highestTurnScore', 'MAX'],
  ['fastestWinTurns', 'MIN'],
  ['fastestLossTurns', 'MIN'],
  ['mostPlayersInGame', 'MAX'],
  ['longestGameRounds', 'MAX'],
  ['highestFeuerwerkTurnScore', 'MAX'],
  ['highestX2TurnScore', 'MAX'],
  ['mostCardsInTurn', 'MAX'],
  ['highestForfeitedTurnScore', 'MAX'],
];

export interface DeviceStatsRow {
  deviceId: string;
  mode: GameMode;
  gamesPlayed: number;
  wins: number;
  pointsDeducted: number;
  plusMinusCompleted: number;
  plusMinusFailed: number;
  kniffelCompleted: number;
  kniffelFailed: number;
  skipped: number;
  feuerwerkReceived: number;
  kleeblattFailed: number;
  kleeblattCompleted: number;
  x2Received: number;
  totalPlaytime: number;
  totalTurns: number;
  busts: number;
  feuerwerkBusts: number;
  x2Busts: number;
  feuerwerkPointsScored: number;
  x2PointsScored: number;
  totalScore: number;
  highestTurnScore: number | null;
  fastestWinTurns: number | null;
  fastestLossTurns: number | null;
  currentWinStreak: number;
  bestWinStreak: number;
  mostPlayersInGame: number | null;
  totalPlayersSum: number;
  longestGameRounds: number | null;
  totalRoundsSum: number;
  highestFeuerwerkTurnScore: number | null;
  highestX2TurnScore: number | null;
  totalTuttos: number;
  mostCardsInTurn: number | null;
  highestForfeitedTurnScore: number | null;
}

export type StatsPayload = Record<string, number | boolean | null>;

// A device holds one row per mode, so the mode is part of the key, not a
// filter that can be left off: `.where({ deviceId })` alone would return
// whichever of the two rows SQLite happened to reach first.
export const getDeviceStats = async (
  deviceId: string,
  mode: GameMode = DEFAULT_GAME_MODE,
): Promise<DeviceStatsRow | null> => {
  try {
    const row = await knex('device_statistics').where({ deviceId, mode }).first<DeviceStatsRow>();
    return row ?? null;
  } catch (err) {
    console.error('getDeviceStats error:', err);
    throw err;
  }
};

export const updateDeviceStats = async (
  deviceId: string,
  stats: StatsPayload,
  mode: GameMode = DEFAULT_GAME_MODE,
): Promise<boolean> => {
  if (!stats || Object.keys(stats).length === 0) return true;

  const deviceCols = [
    'gamesPlayed', 'wins', 'pointsDeducted', 'plusMinusCompleted',
    'plusMinusFailed', 'kniffelCompleted', 'kniffelFailed', 'skipped',
    'feuerwerkReceived', 'kleeblattFailed', 'kleeblattCompleted', 'x2Received',
    'totalPlaytime', 'totalTurns', 'busts', 'feuerwerkBusts', 'x2Busts',
    'feuerwerkPointsScored', 'x2PointsScored', 'totalScore',
    'totalPlayersSum', 'totalRoundsSum', 'totalTuttos',
  ];

  const data: Record<string, unknown> = { deviceId, mode };
  const mergeCols: Record<string, Knex.Raw> = {};

  deviceCols.forEach(col => {
    data[col] = (stats[col] as number | undefined) ?? 0;
    mergeCols[col] = knex.raw(`device_statistics.${col} + EXCLUDED.${col}`);
  });

  // Streak isn't additive like the columns above — it depends on whether
  // THIS game was a win, not a running sum. Only touched when the payload
  // actually records a game result (`wins` present): a partial update (e.g.
  // an admin POST /api/stats/:deviceId adjusting totalPlaytime alone) would
  // otherwise read as a loss and silently reset currentWinStreak to 0.
  // Mirrors updateGlobalStats' recordsGame gate below. A fresh row created
  // by a partial update gets the columns' schema default (0) instead.
  if ('wins' in stats) {
    const wonThisGame = data.wins ? 1 : 0;
    data.currentWinStreak = wonThisGame;
    data.bestWinStreak = wonThisGame;
    mergeCols.currentWinStreak = knex.raw(`
      CASE WHEN EXCLUDED.wins = 1 THEN device_statistics.currentWinStreak + 1 ELSE 0 END
    `);
    mergeCols.bestWinStreak = knex.raw(`
      CASE
        WHEN EXCLUDED.wins = 1 AND device_statistics.currentWinStreak + 1 > device_statistics.bestWinStreak
          THEN device_statistics.currentWinStreak + 1
        ELSE device_statistics.bestWinStreak
      END
    `);
  }

  for (const [col, agg] of RECORD_COLUMNS) {
    if (stats[col] === undefined) continue;
    data[col] = stats[col];
    mergeCols[col] = knex.raw(nullSafeExtreme(agg, 'device_statistics', col, `EXCLUDED.${col}`));
  }

  try {
    await knex('device_statistics')
      .insert(data)
      .onConflict(['deviceId', 'mode'])
      .merge(mergeCols);
    return true;
  } catch (err) {
    console.error('updateDeviceStats error:', err);
    throw err;
  }
};

export interface GlobalStatsRow {
  // One row per ruleset ('modernized' | 'classic'), both seeded by migration —
  // updateGlobalStats never inserts and hard-fails on a missing row.
  ruleset: Ruleset;
  totalGamesPlayed: number;
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
  defaultGamesPlayed: number;
  customGamesPlayed: number;
  totalFeuerwerkBusts: number;
  totalx2Busts: number;
  totalBusts: number;
  highestTurnScore: number | null;
  fastestWinTurns: number | null;
  fastestLossTurns: number | null;
  mostPlayersInGame: number | null;
  totalPlayersSum: number;
  longestGameRounds: number | null;
  totalRoundsSum: number;
  highestFeuerwerkTurnScore: number | null;
  highestX2TurnScore: number | null;
  totalTuttos: number;
  mostCardsInTurn: number | null;
  highestForfeitedTurnScore: number | null;
}

export const getGlobalStats = async (ruleset: Ruleset = DEFAULT_RULESET): Promise<GlobalStatsRow | null> => {
  try {
    const row = await knex('global_statistics').where({ ruleset }).first<GlobalStatsRow>();
    return row ?? null;
  } catch (err) {
    console.error('getGlobalStats error:', err);
    throw err;
  }
};

export const updateGlobalStats = async (stats: StatsPayload, ruleset: Ruleset = DEFAULT_RULESET): Promise<number> => {
  if (!stats || Object.keys(stats).length === 0) return 0;

  // A game is only actually being recorded when the payload carries the
  // isDefaultGame flag (the socket handler always sets it, from the mode the
  // server froze at kickoff). Partial updates — e.g. an admin
  // POST /api/stats/global adjusting one counter — must not count a phantom
  // game: the games-played-by-type columns previously always summed to +1 per
  // call, drifting apart from totalGamesPlayed.
  const recordsGame = 'isDefaultGame' in stats;

  // A custom game leaves exactly one mark on the global statistics: that it
  // happened. None of its sums, and — the reason this branch exists — none of
  // its records. A shortened winning score or a restacked deck buys a "fastest
  // win" and a "highest turn" no normal game can beat, and those are MAX/MIN
  // columns: once written, nothing dislodges them.
  //
  // Lives here rather than in the caller so the socket path and the admin HTTP
  // path cannot come to different conclusions about the same payload.
  if (recordsGame && !stats.isDefaultGame) {
    try {
      const changes = await knex('global_statistics').where({ ruleset })
        .update({ customGamesPlayed: knex.raw('global_statistics.customGamesPlayed + 1') });
      if (changes === 0) throw new Error('global_statistics row missing — run migrations');
      return changes;
    } catch (err) {
      console.error('updateGlobalStats error:', err);
      throw err;
    }
  }

  const globalMapping: Record<string, number> = {
    totalGamesPlayed: (stats.gamesPlayed as number | undefined) ?? 0,
    totalPlaytime: (stats.totalPlaytime as number | undefined) ?? 0,
    totalPlusMinus: (stats.totalPlusMinus as number | undefined) ?? 0,
    totalKniffel: (stats.totalKniffel as number | undefined) ?? 0,
    totalStop: (stats.totalStop as number | undefined) ?? 0,
    totalFeuerwerk: (stats.totalFeuerwerk as number | undefined) ?? 0,
    totalKleeblatt: (stats.totalKleeblatt as number | undefined) ?? 0,
    totalKleeblattCompleted: (stats.totalKleeblattCompleted as number | undefined) ?? 0,
    totalx2: (stats.totalx2 as number | undefined) ?? 0,
    totalTurns: (stats.totalTurns as number | undefined) ?? 0,
    totalScore: (stats.totalScore as number | undefined) ?? 0,
    totalPlusMinusCompleted: (stats.totalPlusMinusCompleted as number | undefined) ?? 0,
    totalKniffelCompleted: (stats.totalKniffelCompleted as number | undefined) ?? 0,
    totalFeuerwerkPoints: (stats.totalFeuerwerkPoints as number | undefined) ?? 0,
    totalx2Points: (stats.totalx2Points as number | undefined) ?? 0,
    // Only the default-game counter here: a custom game never reaches this
    // far, and a partial update records no game at all.
    defaultGamesPlayed: recordsGame && stats.isDefaultGame ? 1 : 0,
    totalFeuerwerkBusts: (stats.totalFeuerwerkBusts as number | undefined) ?? 0,
    totalx2Busts: (stats.totalx2Busts as number | undefined) ?? 0,
    totalBusts: (stats.totalBusts as number | undefined) ?? 0,
    totalPlayersSum: (stats.totalPlayersSum as number | undefined) ?? 0,
    totalRoundsSum: (stats.totalRoundsSum as number | undefined) ?? 0,
    totalTuttos: (stats.totalTuttos as number | undefined) ?? 0,
  };

  const updateData: Record<string, Knex.Raw> = {};
  for (const [col, val] of Object.entries(globalMapping)) {
    updateData[col] = knex.raw(`global_statistics.${col} + ?`, [val]);
  }

  for (const [col, agg] of RECORD_COLUMNS) {
    if (stats[col] === undefined) continue;
    const val = stats[col];
    updateData[col] = knex.raw(nullSafeExtreme(agg, 'global_statistics', col, '?'), [val, val, val]);
  }

  try {
    const changes = await knex('global_statistics').where({ ruleset }).update(updateData);
    if (changes === 0) throw new Error('global_statistics row missing — run migrations');
    return changes;
  } catch (err) {
    console.error('updateGlobalStats error:', err);
    throw err;
  }
};

export default { initDb, getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats, knex };
