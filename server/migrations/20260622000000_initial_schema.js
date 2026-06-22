exports.up = async function(knex) {
  // Ensure the device_statistics table and all its columns exist
  const hasDeviceStats = await knex.schema.hasTable('device_statistics');
  if (!hasDeviceStats) {
    await knex.schema.createTable('device_statistics', table => {
      table.string('deviceId').primary();
    });
  }

  // Define all device_statistics columns with their default values
  const deviceCols = [
    { name: 'gamesPlayed', type: 'integer', default: 0 },
    { name: 'wins', type: 'integer', default: 0 },
    { name: 'pointsDeducted', type: 'integer', default: 0 },
    { name: 'plusMinusCompleted', type: 'integer', default: 0 },
    { name: 'plusMinusFailed', type: 'integer', default: 0 },
    { name: 'kniffelCompleted', type: 'integer', default: 0 },
    { name: 'kniffelFailed', type: 'integer', default: 0 },
    { name: 'skipped', type: 'integer', default: 0 },
    { name: 'feuerwerkReceived', type: 'integer', default: 0 },
    { name: 'kleeblattFailed', type: 'integer', default: 0 },
    { name: 'kleeblattCompleted', type: 'integer', default: 0 },
    { name: 'x2Received', type: 'integer', default: 0 },
    { name: 'totalPlaytime', type: 'integer', default: 0 },
    { name: 'totalTurns', type: 'integer', default: 0 },
    { name: 'busts', type: 'integer', default: 0 },
    { name: 'feuerwerkBusts', type: 'integer', default: 0 },
    { name: 'x2Busts', type: 'integer', default: 0 },
    { name: 'feuerwerkPointsScored', type: 'integer', default: 0 },
    { name: 'x2PointsScored', type: 'integer', default: 0 }
  ];

  for (const col of deviceCols) {
    const exists = await knex.schema.hasColumn('device_statistics', col.name);
    if (!exists) {
      await knex.schema.table('device_statistics', table => {
        table[col.type](col.name).defaultTo(col.default);
      });
    }
  }

  // Ensure the global_statistics table and all its columns exist
  const hasGlobalStats = await knex.schema.hasTable('global_statistics');
  if (!hasGlobalStats) {
    await knex.schema.createTable('global_statistics', table => {
      table.integer('id').primary();
    });
    // Insert the single row for global stats
    await knex('global_statistics').insert({ id: 1 });
  }

  const globalCols = [
    { name: 'totalGamesPlayed', type: 'integer', default: 0 },
    { name: 'totalPlaytime', type: 'integer', default: 0 },
    { name: 'totalPlusMinus', type: 'integer', default: 0 },
    { name: 'totalKniffel', type: 'integer', default: 0 },
    { name: 'totalStop', type: 'integer', default: 0 },
    { name: 'totalFeuerwerk', type: 'integer', default: 0 },
    { name: 'totalKleeblatt', type: 'integer', default: 0 },
    { name: 'totalKleeblattCompleted', type: 'integer', default: 0 },
    { name: 'totalx2', type: 'integer', default: 0 },
    { name: 'totalTurns', type: 'integer', default: 0 },
    { name: 'totalScore', type: 'integer', default: 0 },
    { name: 'totalPlusMinusCompleted', type: 'integer', default: 0 },
    { name: 'totalKniffelCompleted', type: 'integer', default: 0 },
    { name: 'totalFeuerwerkPoints', type: 'integer', default: 0 },
    { name: 'totalx2Points', type: 'integer', default: 0 },
    { name: 'defaultGamesPlayed', type: 'integer', default: 0 },
    { name: 'customGamesPlayed', type: 'integer', default: 0 },
    { name: 'totalFeuerwerkBusts', type: 'integer', default: 0 },
    { name: 'totalx2Busts', type: 'integer', default: 0 },
    { name: 'totalBusts', type: 'integer', default: 0 }
  ];

  for (const col of globalCols) {
    const exists = await knex.schema.hasColumn('global_statistics', col.name);
    if (!exists) {
      await knex.schema.table('global_statistics', table => {
        table[col.type](col.name).defaultTo(col.default);
      });
    }
  }
};

exports.down = async function(knex) {
  // We won't drop tables on down, to prevent data loss.
};
