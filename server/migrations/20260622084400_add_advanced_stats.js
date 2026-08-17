// Column adds are guarded individually rather than wrapped in one bare
// alterTable. `down` below drops nothing on purpose, so a rollback removes
// this migration's knex_migrations row while leaving its columns in place —
// the next `migrate:latest` then replays it against a schema that already has
// them, and an unguarded add fails with "duplicate column name", taking the
// server's startup migration down with it. Guarding per column (rather than
// skipping the whole migration when the first one exists) also repairs a
// half-applied schema. Deliberately inlined rather than shared: a migration
// is a snapshot, and must not change behaviour when a helper elsewhere does.
const addColumnIfMissing = async (knex, table, name, define) => {
  if (await knex.schema.hasColumn(table, name)) return;
  await knex.schema.alterTable(table, define);
};

exports.up = async function(knex) {
  await addColumnIfMissing(knex, 'device_statistics', 'highestTurnScore', table => {
    table.integer('highestTurnScore').defaultTo(0);
  });
  await addColumnIfMissing(knex, 'device_statistics', 'fastestWinTurns', table => {
    table.integer('fastestWinTurns').defaultTo(null);
  });
  await addColumnIfMissing(knex, 'device_statistics', 'fastestLossTurns', table => {
    table.integer('fastestLossTurns').defaultTo(null);
  });
  await addColumnIfMissing(knex, 'device_statistics', 'totalScore', table => {
    table.integer('totalScore').defaultTo(0);
  });
  await addColumnIfMissing(knex, 'global_statistics', 'highestTurnScore', table => {
    table.integer('highestTurnScore').defaultTo(0);
  });
  await addColumnIfMissing(knex, 'global_statistics', 'fastestWinTurns', table => {
    table.integer('fastestWinTurns').defaultTo(null);
  });
};

exports.down = function(_knex) {
  // We won't drop columns on down, to prevent data loss.
};
