// Guarded per column — see 20260622084400_add_advanced_stats for why a bare
// alterTable breaks on a replay, and why the helper is inlined here.
const addColumnIfMissing = async (knex, table, name, define) => {
  if (await knex.schema.hasColumn(table, name)) return;
  await knex.schema.alterTable(table, define);
};

exports.up = async function(knex) {
  await addColumnIfMissing(knex, 'device_statistics', 'currentWinStreak', table => {
    table.integer('currentWinStreak').defaultTo(0);
  });
  await addColumnIfMissing(knex, 'device_statistics', 'bestWinStreak', table => {
    table.integer('bestWinStreak').defaultTo(0);
  });
};

exports.down = function(_knex) {
  // We won't drop columns on down, to prevent data loss.
};
