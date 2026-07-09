exports.up = function(knex) {
  return knex.schema
    .alterTable('device_statistics', table => {
      table.integer('highestTurnScore').defaultTo(0);
      table.integer('fastestWinTurns').defaultTo(null);
      table.integer('fastestLossTurns').defaultTo(null);
      table.integer('totalScore').defaultTo(0);
    })
    .alterTable('global_statistics', table => {
      table.integer('highestTurnScore').defaultTo(0);
      table.integer('fastestWinTurns').defaultTo(null);
    });
};

exports.down = function(_knex) {
  // We won't drop columns on down, to prevent data loss.
};
