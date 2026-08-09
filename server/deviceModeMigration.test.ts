/** @vitest-environment node */
import { describe, it, expect, afterEach } from 'vitest';
import knexLib from 'knex';
import type { Knex } from 'knex';
import migration from './migrations/20260809000000_add_device_stats_mode';

// Deliberately NOT placed under server/migrations/ — see the note in
// gameStatsMigration.test.ts for why a test file in that directory breaks the
// knex migration loader.
//
// This migration rebuilds device_statistics (SQLite cannot alter a primary
// key), so what has to be proven is that nothing is lost in the copy: every
// column, every row, under the mode the existing history is declared to be.
describe('20260809000000_add_device_stats_mode migration', () => {
  let knex: Knex;

  afterEach(async () => {
    if (knex) await knex.destroy();
  });

  // The shape as of the previous migration — the state a real database is in
  // when this one runs. Column ORDER here deliberately differs from the order
  // the new table declares, which is what a copy binding by position rather
  // than by name would silently scramble.
  const setupPreMigrationDb = async () => {
    knex = knexLib({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('device_statistics', table => {
      table.string('deviceId').primary();
      table.integer('wins').defaultTo(0);
      table.integer('gamesPlayed').defaultTo(0);
      table.integer('pointsDeducted').defaultTo(0);
      table.integer('plusMinusCompleted').defaultTo(0);
      table.integer('plusMinusFailed').defaultTo(0);
      table.integer('kniffelCompleted').defaultTo(0);
      table.integer('kniffelFailed').defaultTo(0);
      table.integer('skipped').defaultTo(0);
      table.integer('feuerwerkReceived').defaultTo(0);
      table.integer('kleeblattFailed').defaultTo(0);
      table.integer('kleeblattCompleted').defaultTo(0);
      table.integer('x2Received').defaultTo(0);
      table.integer('totalPlaytime').defaultTo(0);
      table.integer('totalTurns').defaultTo(0);
      table.integer('busts').defaultTo(0);
      table.integer('feuerwerkBusts').defaultTo(0);
      table.integer('x2Busts').defaultTo(0);
      table.integer('feuerwerkPointsScored').defaultTo(0);
      table.integer('x2PointsScored').defaultTo(0);
      table.integer('totalScore').defaultTo(0);
      table.integer('highestTurnScore');
      table.integer('fastestWinTurns');
      table.integer('fastestLossTurns');
      table.integer('currentWinStreak').defaultTo(0);
      table.integer('bestWinStreak').defaultTo(0);
      table.integer('mostPlayersInGame').defaultTo(0);
      table.integer('totalPlayersSum').defaultTo(0);
      table.integer('longestGameRounds').defaultTo(0);
      table.integer('totalRoundsSum').defaultTo(0);
      table.integer('highestFeuerwerkTurnScore').defaultTo(0);
      table.integer('highestX2TurnScore').defaultTo(0);
    });
    return knex;
  };

  const EXISTING_ROW = {
    deviceId: 'veteran-device',
    gamesPlayed: 12, wins: 7, pointsDeducted: 3, plusMinusCompleted: 4,
    plusMinusFailed: 2, kniffelCompleted: 5, kniffelFailed: 1, skipped: 9,
    feuerwerkReceived: 6, kleeblattFailed: 2, kleeblattCompleted: 3,
    x2Received: 8, totalPlaytime: 4200, totalTurns: 140, busts: 30,
    feuerwerkBusts: 2, x2Busts: 4, feuerwerkPointsScored: 2400,
    x2PointsScored: 3300, totalScore: 51000, highestTurnScore: 2100,
    fastestWinTurns: 11, fastestLossTurns: 14, currentWinStreak: 3,
    bestWinStreak: 5, mostPlayersInGame: 6, totalPlayersSum: 40,
    longestGameRounds: 22, totalRoundsSum: 180,
    highestFeuerwerkTurnScore: 1600, highestX2TurnScore: 1900,
  };

  it('keeps every value of an existing row, under the normalized mode', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert(EXISTING_ROW);

    await migration.up(db);

    const row = await db('device_statistics').where({ deviceId: 'veteran-device' }).first();
    // History predates the split and cannot be taken apart retroactively — it
    // is declared normalized so nobody's numbers visibly change.
    expect(row.mode).toBe('normalized');
    for (const [col, value] of Object.entries(EXISTING_ROW)) {
      expect(row[col], `column ${col}`).toBe(value);
    }
  });

  it('preserves a null record column rather than defaulting it to zero', async () => {
    // fastestWinTurns is nullable and MIN-merged: a 0 copied in where a null
    // belonged would read as "won in zero turns" and lock the record forever.
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'no-records', gamesPlayed: 1 });

    await migration.up(db);

    const row = await db('device_statistics').where({ deviceId: 'no-records' }).first();
    expect(row.fastestWinTurns).toBeNull();
    expect(row.highestTurnScore).toBeNull();
  });

  it('carries every device over, not just the first', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert([
      { deviceId: 'dev-a', gamesPlayed: 1 },
      { deviceId: 'dev-b', gamesPlayed: 2 },
      { deviceId: 'dev-c', gamesPlayed: 3 },
    ]);

    await migration.up(db);

    const rows = await db('device_statistics').orderBy('deviceId');
    expect(rows.map(r => r.deviceId)).toEqual(['dev-a', 'dev-b', 'dev-c']);
    expect(rows.every(r => r.mode === 'normalized')).toBe(true);
  });

  it('lets one device hold a separate row per mode', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'both-modes', gamesPlayed: 5 });

    await migration.up(db);
    await db('device_statistics').insert({ deviceId: 'both-modes', mode: 'custom', gamesPlayed: 99 });

    const rows = await db('device_statistics').where({ deviceId: 'both-modes' }).orderBy('mode');
    expect(rows.map(r => ({ mode: r.mode, gamesPlayed: r.gamesPlayed })))
      .toEqual([{ mode: 'custom', gamesPlayed: 99 }, { mode: 'normalized', gamesPlayed: 5 }]);
  });

  it('still rejects a duplicate of the same device in the same mode', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'dupe', gamesPlayed: 1 });

    await migration.up(db);

    await expect(db('device_statistics').insert({ deviceId: 'dupe', mode: 'normalized', gamesPlayed: 2 }))
      .rejects.toThrow();
  });

  it('leaves no leftover scratch table behind', async () => {
    const db = await setupPreMigrationDb();
    await migration.up(db);

    expect(await db.schema.hasTable('device_statistics_new')).toBe(false);
    expect(await db.schema.hasTable('device_statistics')).toBe(true);
  });

  it('down() is a no-op and keeps the rebuilt table (avoids destructive rollbacks)', async () => {
    const db = await setupPreMigrationDb();
    await db('device_statistics').insert({ deviceId: 'kept', gamesPlayed: 4 });
    await migration.up(db);
    await migration.down(db);

    const row = await db('device_statistics').where({ deviceId: 'kept' }).first();
    expect(row.gamesPlayed).toBe(4);
    expect(row.mode).toBe('normalized');
  });
});
