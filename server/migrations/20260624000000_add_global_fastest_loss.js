exports.up = async function(knex) {
  const exists = await knex.schema.hasColumn('global_statistics', 'fastestLossTurns');
  if (!exists) {
    await knex.schema.table('global_statistics', table => {
      table.integer('fastestLossTurns').defaultTo(null);
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.table('global_statistics', table => {
    table.dropColumn('fastestLossTurns');
  });
};
