exports.up = function(knex) {
  return knex.schema.alterTable('device_statistics', table => {
    table.integer('currentWinStreak').defaultTo(0);
    table.integer('bestWinStreak').defaultTo(0);
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('device_statistics', table => {
    table.dropColumn('currentWinStreak');
    table.dropColumn('bestWinStreak');
  });
};
