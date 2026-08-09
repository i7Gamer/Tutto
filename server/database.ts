import knexLib from 'knex';
import type { Knex } from 'knex';
import knexConfig from './knexfile';

const knex = knexLib(knexConfig);

// Callers (server/index.ts in production, individual test files in TEST_DB
// mode) are responsible for awaiting this before the server accepts traffic
// or a test touches the database — it is intentionally not run as an
// import-time side effect so startup can't race ahead of migrations.
export const initDb = async (): Promise<void> => {
  try {
    await knex.migrate.latest();
    console.log('Database migrated to the latest version.');
  } catch (err) {
    console.error('Failed to run database migrations:', err);
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

export interface DeviceStatsRow {
  deviceId: string;
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
}

export type StatsPayload = Record<string, number | boolean | null>;

export const getDeviceStats = async (deviceId: string): Promise<DeviceStatsRow | null> => {
  try {
    const row = await knex('device_statistics').where({ deviceId }).first<DeviceStatsRow>();
    return row ?? null;
  } catch (err) {
    console.error('getDeviceStats error:', err);
    throw err;
  }
};

export const updateDeviceStats = async (deviceId: string, stats: StatsPayload): Promise<boolean> => {
  if (!stats || Object.keys(stats).length === 0) return true;

  const deviceCols = [
    'gamesPlayed', 'wins', 'pointsDeducted', 'plusMinusCompleted',
    'plusMinusFailed', 'kniffelCompleted', 'kniffelFailed', 'skipped',
    'feuerwerkReceived', 'kleeblattFailed', 'kleeblattCompleted', 'x2Received',
    'totalPlaytime', 'totalTurns', 'busts', 'feuerwerkBusts', 'x2Busts',
    'feuerwerkPointsScored', 'x2PointsScored', 'totalScore',
    'totalPlayersSum', 'totalRoundsSum',
  ];

  const data: Record<string, unknown> = { deviceId };
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

  const deviceExtremeCols: [col: string, agg: 'MAX' | 'MIN'][] = [
    ['highestTurnScore', 'MAX'],
    ['fastestWinTurns', 'MIN'],
    ['fastestLossTurns', 'MIN'],
    ['mostPlayersInGame', 'MAX'],
    ['longestGameRounds', 'MAX'],
    ['highestFeuerwerkTurnScore', 'MAX'],
    ['highestX2TurnScore', 'MAX'],
  ];
  for (const [col, agg] of deviceExtremeCols) {
    if (stats[col] === undefined) continue;
    data[col] = stats[col];
    mergeCols[col] = knex.raw(nullSafeExtreme(agg, 'device_statistics', col, `EXCLUDED.${col}`));
  }

  try {
    await knex('device_statistics')
      .insert(data)
      .onConflict('deviceId')
      .merge(mergeCols);
    return true;
  } catch (err) {
    console.error('updateDeviceStats error:', err);
    throw err;
  }
};

export interface GlobalStatsRow {
  id: number;
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
}

export const getGlobalStats = async (): Promise<GlobalStatsRow | null> => {
  try {
    const row = await knex('global_statistics').where({ id: 1 }).first<GlobalStatsRow>();
    return row ?? null;
  } catch (err) {
    console.error('getGlobalStats error:', err);
    throw err;
  }
};

export const updateGlobalStats = async (stats: StatsPayload): Promise<number> => {
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
      const changes = await knex('global_statistics').where({ id: 1 })
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
  };

  const updateData: Record<string, Knex.Raw> = {};
  for (const [col, val] of Object.entries(globalMapping)) {
    updateData[col] = knex.raw(`global_statistics.${col} + ?`, [val]);
  }

  const globalExtremeCols: [col: string, agg: 'MAX' | 'MIN'][] = [
    ['highestTurnScore', 'MAX'],
    ['fastestWinTurns', 'MIN'],
    ['fastestLossTurns', 'MIN'],
    ['mostPlayersInGame', 'MAX'],
    ['longestGameRounds', 'MAX'],
    ['highestFeuerwerkTurnScore', 'MAX'],
    ['highestX2TurnScore', 'MAX'],
  ];
  for (const [col, agg] of globalExtremeCols) {
    if (stats[col] === undefined) continue;
    const val = stats[col];
    updateData[col] = knex.raw(nullSafeExtreme(agg, 'global_statistics', col, '?'), [val, val, val]);
  }

  try {
    const changes = await knex('global_statistics').where({ id: 1 }).update(updateData);
    if (changes === 0) throw new Error('global_statistics row missing — run migrations');
    return changes;
  } catch (err) {
    console.error('updateGlobalStats error:', err);
    throw err;
  }
};

export default { initDb, getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats, knex };
