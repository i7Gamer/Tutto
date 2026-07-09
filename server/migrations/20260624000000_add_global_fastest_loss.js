exports.up = async function(knex) {
  const exists = await knex.schema.hasColumn('global_statistics', 'fastestLossTurns');
  if (!exists) {
    await knex.schema.table('global_statistics', table => {
      table.integer('fastestLossTurns').defaultTo(null);
    });
  }
};

exports.down = async function(_knex) {
  // We won't drop columns on down, to prevent data loss.
};
