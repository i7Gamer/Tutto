/**
 * Classic game mode statistics.
 *
 * device_statistics — additive: the new counter defaults to 0 and is summed;
 * the two record columns are nullable with NO default (a stored 0 would read
 * as "the record is zero" where NULL means "no record yet" — see the warning
 * in 20260809000000_add_device_stats_mode.js). New mode values ('classic',
 * 'classic_custom') need no schema change: mode is TEXT and already part of
 * the primary key.
 *
 * global_statistics — rebuilt keyed by ruleset. Each ruleset gets its own row
 * with the full sums/records plus its own customGamesPlayed counter, so
 * classic games can never move the modernized totals or records (and vice
 * versa). SQLite cannot alter a primary key, so this is the standard table
 * swap in one transaction, with explicit column lists on both sides (never
 * SELECT * — column order is not guaranteed identical across databases
 * migrated at different points in history). BOTH rows are seeded here:
 * updateGlobalStats never inserts and hard-fails on a missing row.
 */

// The global columns as they stand after 20260707000000_add_game_stats.js —
// frozen here on purpose; later columns come from later migrations.
const GLOBAL_COUNTER_COLS = [
  'totalGamesPlayed', 'totalPlaytime', 'totalPlusMinus', 'totalKniffel',
  'totalStop', 'totalFeuerwerk', 'totalKleeblatt', 'totalKleeblattCompleted',
  'totalx2', 'totalTurns', 'totalScore', 'totalPlusMinusCompleted',
  'totalKniffelCompleted', 'totalFeuerwerkPoints', 'totalx2Points',
  'defaultGamesPlayed', 'customGamesPlayed', 'totalFeuerwerkBusts',
  'totalx2Busts', 'totalBusts', 'totalPlayersSum', 'totalRoundsSum',
];

const GLOBAL_RECORD_COLS = [
  'highestTurnScore', 'fastestWinTurns', 'fastestLossTurns',
  'mostPlayersInGame', 'longestGameRounds', 'highestFeuerwerkTurnScore',
  'highestX2TurnScore',
];

// Guarded per column — see 20260622084400_add_advanced_stats for why a bare
// alterTable breaks on a replay, and why the helper is inlined here. One
// hasColumn covering all three declared a schema holding only the first of
// them finished, so the other two were never added and every classic write
// then threw "no such column: mostCardsInTurn".
const addColumnIfMissing = async (knex, table, name, define) => {
  if (await knex.schema.hasColumn(table, name)) return;
  await knex.schema.alterTable(table, define);
};

exports.up = async function up(knex) {
  await addColumnIfMissing(knex, 'device_statistics', 'totalTuttos', (table) => {
    table.integer('totalTuttos').notNullable().defaultTo(0);
  });
  // Nullable with NO default: a stored 0 would read as "the record is zero"
  // where NULL means "no record yet" — see the header comment above.
  await addColumnIfMissing(knex, 'device_statistics', 'mostCardsInTurn', (table) => {
    table.integer('mostCardsInTurn');
  });
  await addColumnIfMissing(knex, 'device_statistics', 'highestForfeitedTurnScore', (table) => {
    table.integer('highestForfeitedTurnScore');
  });

  const hasRuleset = await knex.schema.hasColumn('global_statistics', 'ruleset');
  if (hasRuleset) return;

  await knex.transaction(async (trx) => {
    await trx.schema.createTable('global_statistics_new', (table) => {
      table.string('ruleset').primary();
      for (const col of GLOBAL_COUNTER_COLS) {
        table.integer(col).notNullable().defaultTo(0);
      }
      for (const col of GLOBAL_RECORD_COLS) {
        table.integer(col);
      }
      // The classic additions, part of the rebuilt shape from day one.
      table.integer('totalTuttos').notNullable().defaultTo(0);
      table.integer('mostCardsInTurn');
      table.integer('highestForfeitedTurnScore');
    });

    const copyCols = [...GLOBAL_COUNTER_COLS, ...GLOBAL_RECORD_COLS].join(', ');
    await trx.raw(
      `INSERT INTO global_statistics_new (ruleset, ${copyCols})
       SELECT 'modernized', ${copyCols} FROM global_statistics WHERE id = 1`
    );
    // A database that somehow lacked the id=1 row (the ensure-row migration
    // normally guarantees it) still gets a modernized row.
    const modernized = await trx('global_statistics_new').where({ ruleset: 'modernized' }).first();
    if (!modernized) {
      await trx('global_statistics_new').insert({ ruleset: 'modernized' });
    }
    await trx('global_statistics_new').insert({ ruleset: 'classic' });

    await trx.schema.dropTable('global_statistics');
    await trx.schema.renameTable('global_statistics_new', 'global_statistics');
  });
};

// No-op by repo convention: down migrations never destroy data.
exports.down = async function down() {};
