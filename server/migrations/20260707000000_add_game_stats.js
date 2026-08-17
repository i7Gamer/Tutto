// Guarded per column — see 20260622084400_add_advanced_stats for why a bare
// alterTable breaks on a replay, and why the helper is inlined here.
const addColumnIfMissing = async (knex, table, name, define) => {
  if (await knex.schema.hasColumn(table, name)) return;
  await knex.schema.alterTable(table, define);
};

// Same set on both tables.
const GAME_STAT_COLUMNS = [
  'mostPlayersInGame',
  'totalPlayersSum',
  'longestGameRounds',
  'totalRoundsSum',
  'highestFeuerwerkTurnScore',
  'highestX2TurnScore',
];

exports.up = async function(knex) {
  // Read BEFORE the columns are added: it is what decides whether the backfill
  // below still has anything to do.
  const alreadyApplied = await knex.schema.hasColumn('device_statistics', 'totalPlayersSum');

  for (const table of ['device_statistics', 'global_statistics']) {
    for (const column of GAME_STAT_COLUMNS) {
      await addColumnIfMissing(knex, table, column, t => {
        t.integer(column).defaultTo(0);
      });
    }
  }

  // Backfill for rows that already existed before this migration: totalPlayersSum
  // and totalRoundsSum are running sums used to compute averages (sum / gamesPlayed),
  // so leaving them at 0 would make those averages read as 0 despite games having
  // actually been played. Every game requires at least 2 players, so gamesPlayed * 2
  // is a reasonable floor for players-to-date; a round is one turn per player, so
  // totalTurns / 2 approximates rounds played to date for the common 2-player case.
  // mostPlayersInGame gets the same 2-player floor, but only for rows with at least
  // one recorded game — a device/global row that never played anything stays at 0.
  //
  // Skipped on a replay: these are estimates written once over the pre-existing
  // rows, and re-running it would overwrite whatever the app has genuinely
  // recorded since with the estimate again.
  if (alreadyApplied) return;

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
