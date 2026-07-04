import knexLib from 'knex';
import type { Knex } from 'knex';
import knexConfig from './knexfile';

const knex = knexLib(knexConfig);

export const initDb = async (): Promise<void> => {
  try {
    await knex.migrate.latest();
    console.log('Database migrated to the latest version.');
  } catch (err) {
    console.error('Failed to run database migrations:', err);
    throw err;
  }
};

if ((process.env.NODE_ENV !== 'test' && !process.env.TEST_DB) || process.env.FORCE_INIT_DB) {
  void initDb();
}

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
  ];

  const data: Record<string, unknown> = { deviceId };
  const mergeCols: Record<string, Knex.Raw> = {};

  deviceCols.forEach(col => {
    data[col] = (stats[col] as number | undefined) ?? 0;
    mergeCols[col] = knex.raw(`device_statistics.${col} + EXCLUDED.${col}`);
  });

  // Streak isn't additive like the columns above — it depends on whether
  // THIS game was a win, not a running sum. `wins` (0 or 1) is always present
  // via deviceCols, so this can run unconditionally alongside it.
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

  if (stats.highestTurnScore !== undefined) {
    data.highestTurnScore = stats.highestTurnScore;
    // sqlite's scalar MAX(x, NULL) is NULL, so a null in the payload would wipe
    // the stored maximum without the explicit NULL handling.
    mergeCols.highestTurnScore = knex.raw(`
      CASE
        WHEN EXCLUDED.highestTurnScore IS NULL THEN device_statistics.highestTurnScore
        WHEN device_statistics.highestTurnScore IS NULL THEN EXCLUDED.highestTurnScore
        ELSE MAX(device_statistics.highestTurnScore, EXCLUDED.highestTurnScore)
      END
    `);
  }
  if (stats.fastestWinTurns !== undefined) {
    data.fastestWinTurns = stats.fastestWinTurns;
    mergeCols.fastestWinTurns = knex.raw(`
      CASE
        WHEN EXCLUDED.fastestWinTurns IS NULL THEN device_statistics.fastestWinTurns
        WHEN device_statistics.fastestWinTurns IS NULL THEN EXCLUDED.fastestWinTurns
        ELSE MIN(device_statistics.fastestWinTurns, EXCLUDED.fastestWinTurns)
      END
    `);
  }
  if (stats.fastestLossTurns !== undefined) {
    data.fastestLossTurns = stats.fastestLossTurns;
    mergeCols.fastestLossTurns = knex.raw(`
      CASE
        WHEN EXCLUDED.fastestLossTurns IS NULL THEN device_statistics.fastestLossTurns
        WHEN device_statistics.fastestLossTurns IS NULL THEN EXCLUDED.fastestLossTurns
        ELSE MIN(device_statistics.fastestLossTurns, EXCLUDED.fastestLossTurns)
      END
    `);
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
    defaultGamesPlayed: stats.isDefaultGame ? 1 : 0,
    customGamesPlayed: stats.isDefaultGame ? 0 : 1,
    totalFeuerwerkBusts: (stats.totalFeuerwerkBusts as number | undefined) ?? 0,
    totalx2Busts: (stats.totalx2Busts as number | undefined) ?? 0,
    totalBusts: (stats.totalBusts as number | undefined) ?? 0,
  };

  const updateData: Record<string, Knex.Raw> = {};
  for (const [col, val] of Object.entries(globalMapping)) {
    updateData[col] = knex.raw(`global_statistics.${col} + ?`, [val]);
  }

  if (stats.highestTurnScore !== undefined) {
    // See updateDeviceStats: MAX(x, NULL) is NULL in sqlite.
    updateData.highestTurnScore = knex.raw(`
      CASE
        WHEN ? IS NULL THEN global_statistics.highestTurnScore
        WHEN global_statistics.highestTurnScore IS NULL THEN ?
        ELSE MAX(global_statistics.highestTurnScore, ?)
      END
    `, [stats.highestTurnScore, stats.highestTurnScore, stats.highestTurnScore]);
  }
  if (stats.fastestWinTurns !== undefined) {
    updateData.fastestWinTurns = knex.raw(`
      CASE
        WHEN ? IS NULL THEN global_statistics.fastestWinTurns
        WHEN global_statistics.fastestWinTurns IS NULL THEN ?
        ELSE MIN(global_statistics.fastestWinTurns, ?)
      END
    `, [stats.fastestWinTurns, stats.fastestWinTurns, stats.fastestWinTurns]);
  }
  if (stats.fastestLossTurns !== undefined) {
    updateData.fastestLossTurns = knex.raw(`
      CASE
        WHEN ? IS NULL THEN global_statistics.fastestLossTurns
        WHEN global_statistics.fastestLossTurns IS NULL THEN ?
        ELSE MIN(global_statistics.fastestLossTurns, ?)
      END
    `, [stats.fastestLossTurns, stats.fastestLossTurns, stats.fastestLossTurns]);
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
