const knexConfig = require('./knexfile.js');
const knex = require('knex')(knexConfig);

const initDb = async () => {
  try {
    await knex.migrate.latest();
    console.log('Database migrated to the latest version.');
  } catch (err) {
    console.error('Failed to run database migrations:', err);
    throw err;
  }
};

// Automatically run migrations on startup if not testing
if (process.env.NODE_ENV !== 'test' && !process.env.TEST_DB) {
  initDb();
}

const getDeviceStats = async (deviceId) => {
  try {
    const row = await knex('device_statistics').where({ deviceId }).first();
    return row || null;
  } catch (err) {
    console.error('getDeviceStats error:', err);
    throw err;
  }
};

const updateDeviceStats = async (deviceId, stats) => {
  const deviceCols = [
    'gamesPlayed', 'wins', 'pointsDeducted', 'plusMinusCompleted', 
    'plusMinusFailed', 'kniffelCompleted', 'kniffelFailed', 'skipped', 
    'feuerwerkReceived', 'kleeblattFailed', 'kleeblattCompleted', 'x2Received', 
    'totalPlaytime', 'totalTurns', 'busts', 'feuerwerkBusts', 'x2Busts', 
    'feuerwerkPointsScored', 'x2PointsScored', 'totalScore'
  ];

  const data = { deviceId };
  const mergeCols = {};

  deviceCols.forEach(col => {
    data[col] = stats[col] || 0;
    mergeCols[col] = knex.raw(`device_statistics.${col} + EXCLUDED.${col}`);
  });

  if (stats.highestTurnScore !== undefined) {
    data.highestTurnScore = stats.highestTurnScore;
    mergeCols.highestTurnScore = knex.raw(`MAX(device_statistics.highestTurnScore, EXCLUDED.highestTurnScore)`);
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

const getGlobalStats = async () => {
  try {
    const row = await knex('global_statistics').where({ id: 1 }).first();
    return row || null;
  } catch (err) {
    console.error('getGlobalStats error:', err);
    throw err;
  }
};

const updateGlobalStats = async (stats) => {
  const globalMapping = {
    totalGamesPlayed: stats.gamesPlayed || 0,
    totalPlaytime: stats.totalPlaytime || 0,
    totalPlusMinus: stats.totalPlusMinus || 0,
    totalKniffel: stats.totalKniffel || 0,
    totalStop: stats.totalStop || 0,
    totalFeuerwerk: stats.totalFeuerwerk || 0,
    totalKleeblatt: stats.totalKleeblatt || 0,
    totalKleeblattCompleted: stats.totalKleeblattCompleted || 0,
    totalx2: stats.totalx2 || 0,
    totalTurns: stats.totalTurns || 0,
    totalScore: stats.totalScore || 0,
    totalPlusMinusCompleted: stats.totalPlusMinusCompleted || 0,
    totalKniffelCompleted: stats.totalKniffelCompleted || 0,
    totalFeuerwerkPoints: stats.totalFeuerwerkPoints || 0,
    totalx2Points: stats.totalx2Points || 0,
    defaultGamesPlayed: stats.isDefaultGame ? 1 : 0,
    customGamesPlayed: stats.isDefaultGame ? 0 : 1,
    totalFeuerwerkBusts: stats.totalFeuerwerkBusts || 0,
    totalx2Busts: stats.totalx2Busts || 0,
    totalBusts: stats.totalBusts || 0
  };

  const updateData = {};
  for (const [col, val] of Object.entries(globalMapping)) {
    updateData[col] = knex.raw(`global_statistics.${col} + ?`, [val]);
  }

  if (stats.highestTurnScore !== undefined) {
    updateData.highestTurnScore = knex.raw(`MAX(global_statistics.highestTurnScore, ?)`, [stats.highestTurnScore]);
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
    return changes;
  } catch (err) {
    console.error('updateGlobalStats error:', err);
    throw err;
  }
};

module.exports = { initDb, getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats, knex };
