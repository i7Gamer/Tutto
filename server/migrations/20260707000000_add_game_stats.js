exports.up = async function(knex) {
  await knex.schema
    .alterTable('device_statistics', table => {
      table.integer('mostPlayersInGame').defaultTo(0);
      table.integer('totalPlayersSum').defaultTo(0);
      table.integer('longestGameRounds').defaultTo(0);
      table.integer('totalRoundsSum').defaultTo(0);
      table.integer('highestFeuerwerkTurnScore').defaultTo(0);
      table.integer('highestX2TurnScore').defaultTo(0);
    })
    .alterTable('global_statistics', table => {
      table.integer('mostPlayersInGame').defaultTo(0);
      table.integer('totalPlayersSum').defaultTo(0);
      table.integer('longestGameRounds').defaultTo(0);
      table.integer('totalRoundsSum').defaultTo(0);
      table.integer('highestFeuerwerkTurnScore').defaultTo(0);
      table.integer('highestX2TurnScore').defaultTo(0);
    });

  // Backfill for rows that already existed before this migration: totalPlayersSum
  // and totalRoundsSum are running sums used to compute averages (sum / gamesPlayed),
  // so leaving them at 0 would make those averages read as 0 despite games having
  // actually been played. Every game requires at least 2 players, so gamesPlayed * 2
  // is a reasonable floor for players-to-date; a round is one turn per player, so
  // totalTurns / 2 approximates rounds played to date for the common 2-player case.
  // mostPlayersInGame gets the same 2-player floor, but only for rows with at least
  // one recorded game — a device/global row that never played anything stays at 0.
  await knex('device_statistics').update({
    totalPlayersSum: knex.raw('gamesPlayed * 2'),
    totalRoundsSum: knex.raw('totalTurns / 2'),
    mostPlayersInGame: knex.raw('CASE WHEN gamesPlayed > 0 THEN 2 ELSE 0 END'),
  });
  await knex('global_statistics').update({
    totalPlayersSum: knex.raw('totalGamesPlayed * 2'),
    totalRoundsSum: knex.raw('totalTurns / 2'),
    mostPlayersInGame: knex.raw('CASE WHEN totalGamesPlayed > 0 THEN 2 ELSE 0 END'),
  });
};

exports.down = function(_knex) {
  // We won't drop columns on down, to prevent data loss.
};
