/** @vitest-environment node */
import { describe, it, expect, afterEach } from 'vitest';
import knexLib from 'knex';
import type { Knex } from 'knex';
import addAdvancedStats from './migrations/20260622084400_add_advanced_stats';
import addWinStreak from './migrations/20260704000000_add_win_streak';
import addGameStats from './migrations/20260707000000_add_game_stats';

/**
 * Re-running a migration must not throw.
 *
 * Every `down` in this directory deliberately drops nothing ("to prevent data
 * loss"), so `knex migrate:down` removes the knex_migrations row while leaving
 * the columns in place. The next `migrate:latest` then replays the migration
 * against a schema that already has them — and a bare alterTable(...add
 * column...) fails there with "duplicate column name", taking the server's
 * startup migration with it.
 *
 * The two newest column-adding migrations (add_global_fastest_loss,
 * classic_stats) already guard with hasColumn. These three predate that and
 * did not.
 *
 * Not placed under server/migrations/ for the reason gameStatsMigration.test.ts
 * gives: knex's loader would try to require() it as a real migration.
 */
describe('migration re-runnability', () => {
  let knex: Knex;

  afterEach(async () => {
    if (knex) await knex.destroy();
  });

  /** The pre-migration schema all three of these alter. */
  const setupPreMigrationDb = async (): Promise<Knex> => {
    knex = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('device_statistics', table => {
      table.string('deviceId').primary();
      table.integer('gamesPlayed').defaultTo(0);
      table.integer('totalTurns').defaultTo(0);
    });
    await knex.schema.createTable('global_statistics', table => {
      table.integer('id').primary();
      table.integer('totalGamesPlayed').defaultTo(0);
      table.integer('totalTurns').defaultTo(0);
    });
    await knex('global_statistics').insert({ id: 1, totalGamesPlayed: 0, totalTurns: 0 });
    return knex;
  };

  const migrations = [
    {
      name: '20260622084400_add_advanced_stats',
      up: addAdvancedStats.up,
      columns: [
        ['device_statistics', 'highestTurnScore'],
        ['device_statistics', 'totalScore'],
        ['global_statistics', 'fastestWinTurns'],
      ],
    },
    {
      name: '20260704000000_add_win_streak',
      up: addWinStreak.up,
      columns: [
        ['device_statistics', 'currentWinStreak'],
        ['device_statistics', 'bestWinStreak'],
      ],
    },
    {
      name: '20260707000000_add_game_stats',
      up: addGameStats.up,
      columns: [
        ['device_statistics', 'mostPlayersInGame'],
        ['device_statistics', 'highestX2TurnScore'],
        ['global_statistics', 'longestGameRounds'],
      ],
    },
  ] as const;

  for (const { name, up, columns } of migrations) {
    it(`${name} can run a second time against its own output`, async () => {
      const db = await setupPreMigrationDb();

      await up(db);
      await expect(up(db)).resolves.not.toThrow();

      for (const [table, column] of columns) {
        expect(await db.schema.hasColumn(table, column), `${table}.${column} survived the replay`).toBe(true);
      }
    });
  }

  // The guard must not turn into "skip the whole migration if any one column
  // exists": a partially-applied schema (an interrupted migration, or a column
  // added by hand) still needs the rest of them.
  it('adds the columns still missing from a half-applied schema', async () => {
    const db = await setupPreMigrationDb();
    await db.schema.alterTable('device_statistics', table => {
      table.integer('currentWinStreak').defaultTo(0);
    });

    await expect(addWinStreak.up(db)).resolves.not.toThrow();

    expect(await db.schema.hasColumn('device_statistics', 'bestWinStreak')).toBe(true);
  });

  // The backfill is an UPDATE over every row, so replaying it must not double
  // the running sums it computes the averages from.
  it('does not re-apply the game-stats backfill on a replay', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'd1', gamesPlayed: 3, totalTurns: 24 });

    await addGameStats.up(db);
    const afterFirst = await db('device_statistics').where({ deviceId: 'd1' }).first();
    await addGameStats.up(db);
    const afterSecond = await db('device_statistics').where({ deviceId: 'd1' }).first();

    expect(afterSecond.totalPlayersSum).toBe(afterFirst.totalPlayersSum);
    expect(afterSecond.totalRoundsSum).toBe(afterFirst.totalRoundsSum);
  });
});
