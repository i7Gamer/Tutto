import { describe, it, expect, afterEach } from 'vitest';
import knexLib from 'knex';
import type { Knex } from 'knex';
import migration from './migrations/20260707000000_add_game_stats';

// Deliberately NOT placed under server/migrations/ — knex's migration loader
// scans every file in that directory and would try to require() this one as
// a real migration (crashing any spawned server process with "Vitest cannot
// be imported in a CommonJS module using require()").
//
// Isolated from the rest of the migration chain on purpose: this seeds rows
// with the OLD (pre-this-migration) shape, so it can assert on the backfill
// formula (totalPlayersSum = gamesPlayed * 2, totalRoundsSum = totalTurns / 2)
// without needing the full database.ts schema or the other migrations.
describe('20260707000000_add_game_stats migration', () => {
  let knex: Knex;

  afterEach(async () => {
    if (knex) await knex.destroy();
  });

  const setupPreMigrationDb = async () => {
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

  it('backfills totalPlayersSum as gamesPlayed * 2 and totalRoundsSum as totalTurns / 2 for a pre-existing device row', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'existing-device', gamesPlayed: 3, totalTurns: 25 });

    await migration.up(db);

    const row = await db('device_statistics').where({ deviceId: 'existing-device' }).first();
    expect(row.totalPlayersSum).toBe(6); // 3 * 2
    expect(row.totalRoundsSum).toBe(12); // floor(25 / 2)
  });

  it('backfills the global_statistics row from totalGamesPlayed and totalTurns', async () => {
    const db = await setupPreMigrationDb();
    await db('global_statistics').where({ id: 1 }).update({ totalGamesPlayed: 10, totalTurns: 41 });

    await migration.up(db);

    const row = await db('global_statistics').where({ id: 1 }).first();
    expect(row.totalPlayersSum).toBe(20); // 10 * 2
    expect(row.totalRoundsSum).toBe(20); // floor(41 / 2)
  });

  it('backfills to 0 for rows with no games played yet', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'fresh-device', gamesPlayed: 0, totalTurns: 0 });

    await migration.up(db);

    const row = await db('device_statistics').where({ deviceId: 'fresh-device' }).first();
    expect(row.totalPlayersSum).toBe(0);
    expect(row.totalRoundsSum).toBe(0);
    expect(row.mostPlayersInGame).toBe(0);
  });

  it('backfills mostPlayersInGame to 2 for a device row that has played at least one game', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'played-device', gamesPlayed: 1, totalTurns: 5 });

    await migration.up(db);

    const row = await db('device_statistics').where({ deviceId: 'played-device' }).first();
    expect(row.mostPlayersInGame).toBe(2);
  });

  it('backfills mostPlayersInGame to 2 for the global row when at least one game has been played', async () => {
    const db = await setupPreMigrationDb();
    await db('global_statistics').where({ id: 1 }).update({ totalGamesPlayed: 5, totalTurns: 20 });

    await migration.up(db);

    const row = await db('global_statistics').where({ id: 1 }).first();
    expect(row.mostPlayersInGame).toBe(2);
  });

  it('still adds the other 3 new columns with their zero defaults', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'columns-device', gamesPlayed: 1, totalTurns: 5 });

    await migration.up(db);

    const row = await db('device_statistics').where({ deviceId: 'columns-device' }).first();
    expect(row.longestGameRounds).toBe(0);
    expect(row.highestFeuerwerkTurnScore).toBe(0);
    expect(row.highestX2TurnScore).toBe(0);
  });

  it('down() is a no-op and does not drop the new columns (avoids destructive rollbacks)', async () => {
    const db = await setupPreMigrationDb();
    await migration.up(db);
    await migration.down(db);

    const hasDeviceCol = await db.schema.hasColumn('device_statistics', 'totalPlayersSum');
    const hasGlobalCol = await db.schema.hasColumn('global_statistics', 'totalRoundsSum');
    expect(hasDeviceCol).toBe(true);
    expect(hasGlobalCol).toBe(true);
  });
});
