exports.up = async function(knex) {
  // Ensure the global_statistics table has the initial row (id: 1)
  const exists = await knex('global_statistics').where({ id: 1 }).first();
  if (!exists) {
    await knex('global_statistics').insert({ id: 1 });
    console.log('Inserted initial global_statistics row (id: 1)');
  }
};

exports.down = async function(knex) {
  // Don't delete the row on rollback to prevent data loss
};
