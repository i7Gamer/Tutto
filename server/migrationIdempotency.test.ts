/** @vitest-environment node */
import { createRequire } from 'node:module';
import { describe, it, expect, afterEach } from 'vitest';
import knexLib from 'knex';
import type { Knex } from 'knex';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These migrations are untyped CJS (no allowJs in tsconfig.test.json). A
// colocated .d.ts would fix the import, but knex's own migration loader globs
// server/migrations/ for runnable migrations — a .d.ts stub there gets picked
// up as an invalid migration and breaks the real replays this very file drives
// below (migrateAll/db.migrate.latest). require() (typed `any` by @types/node)
// sidesteps static module resolution so the shape is asserted only here.
interface Migration {
  up: (knex: Knex) => Promise<void>;
  down: (knex: Knex) => Promise<void>;
}
const require = createRequire(import.meta.url);
const addAdvancedStats = require('./migrations/20260622084400_add_advanced_stats') as Migration;
const addWinStreak = require('./migrations/20260704000000_add_win_streak') as Migration;
const addGameStats = require('./migrations/20260707000000_add_game_stats') as Migration;
const addDeviceStatsMode = require('./migrations/20260809000000_add_device_stats_mode') as Migration;
const classicStats = require('./migrations/20260810000000_classic_stats') as Migration;
const ensureGlobalStatsRow = require('./migrations/20260625000000_ensure_global_stats_row') as Migration;

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
/**
 * One connection, like the production knexfile's own pool.
 *
 * Every `:memory:` connection is a SEPARATE database. Without this, knex opens
 * its default pool (min 2) and a query can land on a connection that never ran
 * the migrations — so these tests passed in isolation and failed
 * intermittently under a loaded full-suite run, which reads as a broken
 * migration rather than as a pool that handed out the wrong database.
 */
const SINGLE_CONNECTION = { min: 1, max: 1 };

describe('migration re-runnability', () => {
  let knex: Knex;

  afterEach(async () => {
    if (knex) await knex.destroy();
  });

  /** The pre-migration schema all three of these alter. */
  const setupPreMigrationDb = async (): Promise<Knex> => {
    knex = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: SINGLE_CONNECTION });
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

  // classic_stats adds THREE device columns, and guarded all three behind a
  // single hasColumn on the first one. A schema holding only that first
  // column — an interrupted run, or a hand-applied fix — was therefore
  // declared done and the other two were never added, after which every
  // classic write threw "no such column: mostCardsInTurn".
  describe('20260810000000_classic_stats column guards', () => {
    /**
     * device_statistics holding only the first of the three columns, and a
     * global_statistics already keyed by ruleset — so the table swap in the
     * second half of the migration early-returns and these tests are about
     * the column block alone.
     */
    const setupHalfAppliedDb = async (existingColumns: readonly string[]): Promise<Knex> => {
      knex = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: SINGLE_CONNECTION });
      await knex.schema.createTable('device_statistics', table => {
        table.string('deviceId');
        table.string('mode');
        for (const column of existingColumns) table.integer(column);
      });
      await knex.schema.createTable('global_statistics', table => {
        table.string('ruleset').primary();
      });
      return knex;
    };

    const CLASSIC_DEVICE_COLUMNS = ['totalTuttos', 'mostCardsInTurn', 'highestForfeitedTurnScore'] as const;

    it('adds the two still missing when only the first of the three exists', async () => {
      const db = await setupHalfAppliedDb([CLASSIC_DEVICE_COLUMNS[0]]);

      await expect(classicStats.up(db)).resolves.not.toThrow();

      for (const column of CLASSIC_DEVICE_COLUMNS) {
        expect(await db.schema.hasColumn('device_statistics', column), `device_statistics.${column}`).toBe(true);
      }
    });

    it('adds all three to a schema that has none of them', async () => {
      const db = await setupHalfAppliedDb([]);

      await expect(classicStats.up(db)).resolves.not.toThrow();

      for (const column of CLASSIC_DEVICE_COLUMNS) {
        expect(await db.schema.hasColumn('device_statistics', column), `device_statistics.${column}`).toBe(true);
      }
    });

    it('leaves a schema that already has all three exactly as it found it', async () => {
      const db = await setupHalfAppliedDb(CLASSIC_DEVICE_COLUMNS);
      await db('device_statistics').insert({ deviceId: 'd1', mode: 'classic', totalTuttos: 4 });

      await expect(classicStats.up(db)).resolves.not.toThrow();

      const row = await db('device_statistics').where({ deviceId: 'd1' }).first();
      expect(row.totalTuttos, 'a replay adds nothing and drops nothing').toBe(4);
    });
  });

  // The two migrations that rebuild a table rather than add columns to one.
  // Neither could be covered by the pre-migration fixture above — they need
  // the real schema as of their own point in history — so these drive the
  // actual chain and then replay one migration against its finished output,
  // which is exactly what a `knex migrate:down` (every `down` here drops
  // nothing) leaves behind for the next `migrate:latest`.
  describe('the table-rebuilding migrations', () => {
    const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

    const migrateAll = async (): Promise<Knex> => {
      knex = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: SINGLE_CONNECTION });
      await knex.migrate.latest({ directory: MIGRATIONS_DIR });
      return knex;
    };

    it('add_device_stats_mode leaves the custom buckets and the later columns alone on a replay', async () => {
      // Unguarded, its `up` rebuilds device_statistics from its own frozen
      // column list and copies SELECT 'normalized' into every row. Two things
      // follow: every custom and classic bucket is re-stamped as the row the
      // app shows as the player's real record, promoting its numbers into
      // them; and the three columns 20260810 added are not in that list, so
      // they are dropped (that migration's own guard then re-adds them empty).
      const db = await migrateAll();
      await db('device_statistics').insert([
        { deviceId: 'd1', mode: 'normalized', gamesPlayed: 2, highestTurnScore: 500, totalTuttos: 0 },
        { deviceId: 'd1', mode: 'custom', gamesPlayed: 9, highestTurnScore: 9000, totalTuttos: 7 },
      ]);

      await expect(addDeviceStatsMode.up(db)).resolves.not.toThrow();

      const rows = await db('device_statistics').where({ deviceId: 'd1' }).orderBy('mode');
      expect(rows.map(r => r.mode), 'the custom bucket is still custom').toEqual(['custom', 'normalized']);
      expect(rows.find(r => r.mode === 'custom').highestTurnScore).toBe(9000);
      expect(rows.find(r => r.mode === 'normalized').highestTurnScore).toBe(500);
      expect(await db.schema.hasColumn('device_statistics', 'totalTuttos')).toBe(true);
      expect(rows.find(r => r.mode === 'custom').totalTuttos, 'and its value survived').toBe(7);
    });

    it('ensure_global_stats_row does not throw on a replay', async () => {
      // It queries `where({ id: 1 })`, and 20260810 rebuilt global_statistics
      // keyed by `ruleset` — dropping `id` entirely. Replaying it threw
      // SQLITE_ERROR: no such column: id straight out of initDb, before
      // server.listen, on every subsequent start.
      const db = await migrateAll();

      await expect(ensureGlobalStatsRow.up(db)).resolves.not.toThrow();

      const rows = await db('global_statistics');
      expect(rows.map(r => r.ruleset).sort()).toEqual(['classic', 'modernized']);
    });

    it('the whole chain replays cleanly from a finished database', async () => {
      // What a full `migrate:latest` after a rollback actually does. Fails on
      // the FIRST unguarded migration, so it stays honest as more are added.
      const db = await migrateAll();
      await db('knex_migrations').del();

      await expect(db.migrate.latest({ directory: MIGRATIONS_DIR })).resolves.not.toThrow();
    });
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
