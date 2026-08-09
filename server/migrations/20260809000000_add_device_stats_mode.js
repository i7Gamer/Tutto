// Splits device statistics by game mode: a device now holds one row per mode
// ('normalized' | 'custom'), so a game played on a shortened winning score or a
// restacked deck can be recorded in full without touching the numbers a player
// reads as their record.
//
// SQLite cannot alter a primary key, so the table is rebuilt rather than
// altered. Every existing row is declared 'normalized': the history predates
// the split and cannot be taken apart retroactively, and this way nobody's
// visible statistics change on upgrade.

// Nullable, and merged with MIN/MAX rather than summed. A 0 written where a
// null belongs would read as a real record ("won in zero turns") and, being an
// extreme, would never be displaced again — so these must NOT get a default.
const RECORD_COLUMNS = [
  'highestTurnScore',
  'fastestWinTurns',
  'fastestLossTurns',
  'mostPlayersInGame',
  'longestGameRounds',
  'highestFeuerwerkTurnScore',
  'highestX2TurnScore',
];

// Summed on every write, so absent means zero.
const COUNTER_COLUMNS = [
  'gamesPlayed', 'wins', 'pointsDeducted', 'plusMinusCompleted',
  'plusMinusFailed', 'kniffelCompleted', 'kniffelFailed', 'skipped',
  'feuerwerkReceived', 'kleeblattFailed', 'kleeblattCompleted', 'x2Received',
  'totalPlaytime', 'totalTurns', 'busts', 'feuerwerkBusts', 'x2Busts',
  'feuerwerkPointsScored', 'x2PointsScored', 'totalScore',
  'currentWinStreak', 'bestWinStreak', 'totalPlayersSum', 'totalRoundsSum',
];

const DEFAULT_MODE = 'normalized';
const TEMP_TABLE = 'device_statistics_new';

exports.up = async function(knex) {
  await knex.transaction(async trx => {
    await trx.schema.createTable(TEMP_TABLE, table => {
      table.string('deviceId');
      table.string('mode').defaultTo(DEFAULT_MODE);
      COUNTER_COLUMNS.forEach(col => table.integer(col).defaultTo(0));
      RECORD_COLUMNS.forEach(col => table.integer(col));
      table.primary(['deviceId', 'mode']);
    });

    // Column lists spelled out on BOTH sides. `INSERT ... SELECT *` binds by
    // physical column order, and the initial schema builds its table one
    // hasColumn check at a time — so that order is not guaranteed to be the
    // same in two databases that were migrated at different points in history.
    const carried = ['deviceId', ...COUNTER_COLUMNS, ...RECORD_COLUMNS];
    await trx.raw(
      `INSERT INTO ${TEMP_TABLE} (mode, ${carried.join(', ')})
       SELECT ?, ${carried.join(', ')} FROM device_statistics`,
      [DEFAULT_MODE],
    );

    await trx.schema.dropTable('device_statistics');
    await trx.schema.renameTable(TEMP_TABLE, 'device_statistics');
  });
};

exports.down = async function(_knex) {
  // We won't rebuild the old table on down, to prevent data loss: the custom
  // rows have nowhere to go in a single-row-per-device schema.
};
