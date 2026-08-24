exports.up = async function(knex) {
  // 20260810_classic_stats rebuilt global_statistics keyed by `ruleset` and
  // dropped `id`, and it seeds both rows itself — so on any database that has
  // reached that migration there is nothing here to ensure. Without this,
  // replaying (a `knex migrate:down` leaves the schema in place, so the next
  // `migrate:latest` runs this again) threw "no such column: id" out of
  // initDb, before server.listen, on every subsequent start.
  if (!(await knex.schema.hasColumn('global_statistics', 'id'))) return;

  // Ensure the global_statistics table has the initial row (id: 1)
  const exists = await knex('global_statistics').where({ id: 1 }).first();
  if (!exists) {
    await knex('global_statistics').insert({ id: 1 });
    console.log('Inserted initial global_statistics row (id: 1)');
  }
};

exports.down = async function(_knex) {
  // Don't delete the row on rollback to prevent data loss
};
