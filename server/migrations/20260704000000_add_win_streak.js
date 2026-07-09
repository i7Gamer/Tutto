exports.up = function(knex) {
  return knex.schema.alterTable('device_statistics', table => {
    table.integer('currentWinStreak').defaultTo(0);
    table.integer('bestWinStreak').defaultTo(0);
  });
};

exports.down = function(_knex) {
  // We won't drop columns on down, to prevent data loss.
};
