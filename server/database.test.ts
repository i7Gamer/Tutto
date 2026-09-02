/** @vitest-environment node */
process.env.TEST_DB = 'true';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import database, { RECORD_COLUMNS, deviceCols, buildGlobalMapping } from './database';
import { sanitizeStats } from './sanitize';
import { DB_INIT_TIMEOUT_MS } from './testTimeouts';

// The device_statistics/global_statistics columns that exist for reasons
// deviceCols/buildGlobalMapping/RECORD_COLUMNS don't cover: primary keys, and
// the two win-streak and one custom-game-counter columns whose merge logic is
// inline in updateDeviceStats/updateGlobalStats rather than list-driven. Kept
// here rather than duplicated per-table so the schema-lock test below stays a
// single readable union per table.
const DEVICE_STRUCTURAL_COLUMNS = ['deviceId', 'mode', 'currentWinStreak', 'bestWinStreak'];
const GLOBAL_STRUCTURAL_COLUMNS = ['ruleset', 'customGamesPlayed'];

const columnNamesOf = async (table: string): Promise<string[]> => {
  const rows = await database.knex.raw(`PRAGMA table_info(${table})`) as { name: string }[];
  return rows.map(r => r.name);
};

describe('Database Statistics Integration', () => {
  beforeAll(async () => {
    await database.initDb();
  }, DB_INIT_TIMEOUT_MS);

  afterAll(async () => {
    await database.knex.destroy();
  });

  // The first schema lock: database.ts carries several hand-written column
  // lists (deviceCols, buildGlobalMapping, RECORD_COLUMNS) that decide what
  // SQL gets generated, and nothing previously checked them against what the
  // migrations actually created. A column added to a migration but forgotten
  // in one of these lists would silently stop being read or written; a bogus
  // key added to one of these lists (a typo, or a column since renamed) would
  // silently no-op instead of failing loudly. This locks both directions.
  it('keeps deviceCols/buildGlobalMapping/RECORD_COLUMNS in exact sync with the migrated schema', async () => {
    const recordColumnNames = RECORD_COLUMNS.map(([col]) => col);

    const expectedDeviceColumns = [...DEVICE_STRUCTURAL_COLUMNS, ...deviceCols, ...recordColumnNames];
    const actualDeviceColumns = await columnNamesOf('device_statistics');
    expect(new Set(actualDeviceColumns)).toEqual(new Set(expectedDeviceColumns));

    const expectedGlobalColumns = [
      ...GLOBAL_STRUCTURAL_COLUMNS,
      ...Object.keys(buildGlobalMapping({}, false)),
      ...recordColumnNames,
    ];
    const actualGlobalColumns = await columnNamesOf('global_statistics');
    expect(new Set(actualGlobalColumns)).toEqual(new Set(expectedGlobalColumns));
  });
  it('should store and retrieve all device statistics without SQL errors', async () => {
    const mockDeviceId = 'unique-test-device-' + Date.now();
    const mockStats = {
      gamesPlayed: 1,
      wins: 1,
      pointsDeducted: 0,
      plusMinusCompleted: 2,
      plusMinusFailed: 1,
      kniffelCompleted: 3,
      kniffelFailed: 0,
      skipped: 5,
      feuerwerkReceived: 4,
      kleeblattFailed: 1,
      kleeblattCompleted: 1,
      x2Received: 2,
      totalPlaytime: 600,
      totalTurns: 20,
      busts: 4,
      feuerwerkBusts: 1,
      x2Busts: 1,
      feuerwerkPointsScored: 1000,
      x2PointsScored: 2000
    };

    // Update the device stats. This shouldn't throw any SQL errors.
    await database.updateDeviceStats(mockDeviceId, mockStats);

    // Retrieve the device stats.
    const retrievedStats = await database.getDeviceStats(mockDeviceId);

    expect(retrievedStats).not.toBeNull();
    expect(retrievedStats.deviceId).toBe(mockDeviceId);
    expect(retrievedStats.gamesPlayed).toBe(1);
    expect(retrievedStats.feuerwerkBusts).toBe(1);
    expect(retrievedStats.x2Busts).toBe(1);
    expect(retrievedStats.feuerwerkPointsScored).toBe(1000);
    expect(retrievedStats.x2PointsScored).toBe(2000);
    expect(retrievedStats.totalTurns).toBe(20);
    expect(retrievedStats.kleeblattFailed).toBe(1);
    expect(retrievedStats.kleeblattCompleted).toBe(1);
  });

  it('should store and retrieve all global statistics without SQL errors', async () => {
    const mockGlobalStats = {
      gamesPlayed: 1,
      totalPlaytime: 1200,
      totalPlusMinus: 5,
      totalKniffel: 3,
      totalStop: 2,
      totalFeuerwerk: 4,
      totalKleeblatt: 1,
      totalKleeblattCompleted: 1,
      totalx2: 3,
      totalTurns: 30,
      totalScore: 15000,
      totalPlusMinusCompleted: 4,
      totalKniffelCompleted: 2,
      totalFeuerwerkPoints: 2000,
      totalx2Points: 3000,
      totalFeuerwerkBusts: 2,
      totalx2Busts: 1,
      totalBusts: 5,
      isDefaultGame: true
    };

    // Update global stats. This shouldn't throw "no such column" SQL errors.
    await database.updateGlobalStats(mockGlobalStats);

    // Retrieve global stats.
    const retrievedStats = await database.getGlobalStats();

    expect(retrievedStats).not.toBeNull();
    expect(retrievedStats.totalGamesPlayed).toBeGreaterThanOrEqual(1);
    expect(typeof retrievedStats.totalTurns).toBe('number');
    expect(typeof retrievedStats.totalScore).toBe('number');
    expect(typeof retrievedStats.totalFeuerwerkPoints).toBe('number');
    expect(typeof retrievedStats.totalx2Points).toBe('number');
    expect(retrievedStats.totalKleeblatt).toBeGreaterThanOrEqual(1);
    expect(retrievedStats.totalKleeblattCompleted).toBeGreaterThanOrEqual(1);
  });

  it('should not overwrite fastestWinTurns or fastestLossTurns with null', async () => {
    const mockDeviceId = 'test-null-device-' + Date.now();
    
    // First, play a game and win in 10 turns.
    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      fastestWinTurns: 10,
      fastestLossTurns: null
    });
    
    let stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.fastestWinTurns).toBe(10);
    expect(stats.fastestLossTurns).toBeNull();
    
    // Then, play another game and lose in 20 turns. fastestWinTurns is passed as null.
    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      fastestWinTurns: null,
      fastestLossTurns: 20
    });
    
    stats = await database.getDeviceStats(mockDeviceId);
    // fastestWinTurns should still be 10, not null
    expect(stats.fastestWinTurns).toBe(10);
    expect(stats.fastestLossTurns).toBe(20);

    // Test global stats similarly
    await database.updateGlobalStats({
      gamesPlayed: 1,
      fastestWinTurns: 5
    });
    
    let globalStats = await database.getGlobalStats();
    const currentFastestGlobal = globalStats.fastestWinTurns;
    
    await database.updateGlobalStats({
      gamesPlayed: 1,
      fastestWinTurns: null
    });
    
    globalStats = await database.getGlobalStats();
    expect(globalStats.fastestWinTurns).toBe(currentFastestGlobal);
  });

  // The consequence H1 was actually worth fixing for: sqlite binds false as
  // integer 0, and every record column merges through nullSafeExtreme — so a
  // boolean that reached the database pinned a MIN record at 0 permanently.
  // Driven through sanitizeStats, which is what both the socket and the HTTP
  // routes put in front of these functions.
  it('cannot pin a MIN record at zero with a boolean, in either scope', async () => {
    const mockDeviceId = 'test-bool-min-device-' + Date.now();

    await database.updateDeviceStats(mockDeviceId, sanitizeStats({ gamesPlayed: 1, fastestWinTurns: 7 }));
    expect((await database.getDeviceStats(mockDeviceId)).fastestWinTurns).toBe(7);

    await database.updateDeviceStats(mockDeviceId, sanitizeStats({ gamesPlayed: 1, fastestWinTurns: false }));
    expect((await database.getDeviceStats(mockDeviceId)).fastestWinTurns).toBe(7);

    await database.updateGlobalStats(sanitizeStats({ gamesPlayed: 1, fastestWinTurns: 4 }));
    const globalBefore = (await database.getGlobalStats()).fastestWinTurns;

    await database.updateGlobalStats(sanitizeStats({ gamesPlayed: 1, fastestWinTurns: false }));
    expect((await database.getGlobalStats()).fastestWinTurns).toBe(globalBefore);
  });

  it('should not overwrite highestTurnScore with null in device stats', async () => {
    const mockDeviceId = 'test-null-hts-device-' + Date.now();

    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      highestTurnScore: 900,
    });

    let stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.highestTurnScore).toBe(900);

    // A crafted payload with highestTurnScore: null must not wipe the stored
    // max — sqlite's scalar MAX(x, NULL) returns NULL.
    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      highestTurnScore: null,
    });

    stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.highestTurnScore).toBe(900);

    // A real new maximum still wins.
    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      highestTurnScore: 1200,
    });

    stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.highestTurnScore).toBe(1200);
  });

  it('should not overwrite highestTurnScore with null in global stats', async () => {
    await database.updateGlobalStats({
      gamesPlayed: 1,
      highestTurnScore: 900,
    });

    let globalStats = await database.getGlobalStats();
    const currentHighest = globalStats.highestTurnScore;
    expect(currentHighest).toBeGreaterThanOrEqual(900);

    await database.updateGlobalStats({
      gamesPlayed: 1,
      highestTurnScore: null,
    });

    globalStats = await database.getGlobalStats();
    expect(globalStats.highestTurnScore).toBe(currentHighest);
  });

  it('should store and retrieve Kleeblatt losses correctly in global statistics', async () => {
    const mockGlobalStats = {
      gamesPlayed: 1,
      totalPlaytime: 600,
      totalKleeblatt: 1,
      totalKleeblattCompleted: 0,
      isDefaultGame: true
    };

    const initialStats = await database.getGlobalStats() || { totalKleeblatt: 0, totalKleeblattCompleted: 0 };
    await database.updateGlobalStats(mockGlobalStats);
    const retrievedStats = await database.getGlobalStats();

    expect(retrievedStats).not.toBeNull();
    // It should increment totalKleeblatt but NOT totalKleeblattCompleted
    expect(retrievedStats.totalKleeblatt).toBe(initialStats.totalKleeblatt + 1);
    expect(retrievedStats.totalKleeblattCompleted).toBe(initialStats.totalKleeblattCompleted);
  });

  it('does not count a default/custom game when the payload lacks isDefaultGame (partial update)', async () => {
    // e.g. an admin POST /api/stats/global adjusting a single counter — must
    // not increment either games-played-by-type column.
    const before = await database.getGlobalStats();
    await database.updateGlobalStats({ totalPlaytime: 10 });
    const after = await database.getGlobalStats();

    expect(after.defaultGamesPlayed).toBe(before.defaultGamesPlayed);
    expect(after.customGamesPlayed).toBe(before.customGamesPlayed);
    expect(after.totalPlaytime).toBe(before.totalPlaytime + 10);
  });

  it('counts exactly one default game when isDefaultGame is true', async () => {
    const before = await database.getGlobalStats();
    await database.updateGlobalStats({ gamesPlayed: 1, isDefaultGame: true });
    const after = await database.getGlobalStats();

    expect(after.defaultGamesPlayed).toBe(before.defaultGamesPlayed + 1);
    expect(after.customGamesPlayed).toBe(before.customGamesPlayed);
  });

  it('counts exactly one custom game when isDefaultGame is false', async () => {
    const before = await database.getGlobalStats();
    await database.updateGlobalStats({ gamesPlayed: 1, isDefaultGame: false });
    const after = await database.getGlobalStats();

    expect(after.customGamesPlayed).toBe(before.customGamesPlayed + 1);
    expect(after.defaultGamesPlayed).toBe(before.defaultGamesPlayed);
  });

  describe('a device keeps one set of statistics per game mode', () => {
    it('records a custom game without touching the normalized row', async () => {
      const deviceId = 'split-device-' + Date.now();
      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, wins: 1, totalScore: 4000 });

      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, wins: 1, totalScore: 999 }, 'custom');

      const normalized = await database.getDeviceStats(deviceId);
      expect(normalized.gamesPlayed).toBe(1);
      expect(normalized.totalScore).toBe(4000);

      const custom = await database.getDeviceStats(deviceId, 'custom');
      expect(custom.gamesPlayed).toBe(1);
      expect(custom.totalScore).toBe(999);
    });

    it('reads the normalized row when no mode is named', async () => {
      // Every pre-existing caller — the admin route included — means this one.
      const deviceId = 'default-mode-device-' + Date.now();
      await database.updateDeviceStats(deviceId, { gamesPlayed: 3 }, 'normalized');

      expect((await database.getDeviceStats(deviceId)).gamesPlayed).toBe(3);
    });

    it('reports nothing for a mode this device has never played', async () => {
      const deviceId = 'custom-only-device-' + Date.now();
      await database.updateDeviceStats(deviceId, { gamesPlayed: 1 }, 'custom');

      expect(await database.getDeviceStats(deviceId)).toBeNull();
      expect(await database.getDeviceStats(deviceId, 'custom')).not.toBeNull();
    });

    it('runs a separate win streak per mode', async () => {
      // A custom game must not extend the streak a player reads as theirs, and
      // a loss in one mode must not break the other's run.
      const deviceId = 'streak-split-' + Date.now();
      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, wins: 1 });
      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, wins: 1 });

      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, wins: 0 }, 'custom');

      expect((await database.getDeviceStats(deviceId)).currentWinStreak).toBe(2);
      expect((await database.getDeviceStats(deviceId, 'custom')).currentWinStreak).toBe(0);
    });

    it('keeps records apart, so a custom high score is not a personal best', async () => {
      const deviceId = 'record-split-' + Date.now();
      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, highestTurnScore: 1500 });

      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, highestTurnScore: 99999 }, 'custom');

      expect((await database.getDeviceStats(deviceId)).highestTurnScore).toBe(1500);
      expect((await database.getDeviceStats(deviceId, 'custom')).highestTurnScore).toBe(99999);
    });

    it('accumulates across several games in the same mode', async () => {
      const deviceId = 'accumulate-custom-' + Date.now();
      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, busts: 2 }, 'custom');
      await database.updateDeviceStats(deviceId, { gamesPlayed: 1, busts: 3 }, 'custom');

      const custom = await database.getDeviceStats(deviceId, 'custom');
      expect(custom.gamesPlayed).toBe(2);
      expect(custom.busts).toBe(5);
    });
  });

  describe('a custom game contributes nothing but its own count', () => {
    it('leaves every running total untouched', async () => {
      const before = await database.getGlobalStats();

      await database.updateGlobalStats({
        gamesPlayed: 1, totalPlaytime: 999, totalScore: 50000, totalTurns: 40,
        totalBusts: 12, totalKniffel: 3, totalPlayersSum: 6, totalRoundsSum: 20,
        isDefaultGame: false,
      });

      const after = await database.getGlobalStats();
      expect(after.totalGamesPlayed).toBe(before.totalGamesPlayed);
      expect(after.totalPlaytime).toBe(before.totalPlaytime);
      expect(after.totalScore).toBe(before.totalScore);
      expect(after.totalTurns).toBe(before.totalTurns);
      expect(after.totalBusts).toBe(before.totalBusts);
      expect(after.totalKniffel).toBe(before.totalKniffel);
      expect(after.totalPlayersSum).toBe(before.totalPlayersSum);
      expect(after.totalRoundsSum).toBe(before.totalRoundsSum);
      // …and still records that it happened.
      expect(after.customGamesPlayed).toBe(before.customGamesPlayed + 1);
    });

    it('cannot take a record, however good the numbers look', async () => {
      // The whole point of the split: a shortened winning score or a stacked
      // deck buys a "fastest win" and a "highest turn" that no normal game can
      // beat, and those are MAX/MIN columns — once written, they stick.
      await database.updateGlobalStats({
        gamesPlayed: 1, highestTurnScore: 5000, fastestWinTurns: 20,
        longestGameRounds: 30, isDefaultGame: true,
      });
      const before = await database.getGlobalStats();

      await database.updateGlobalStats({
        gamesPlayed: 1, highestTurnScore: 999999, fastestWinTurns: 1,
        fastestLossTurns: 1, mostPlayersInGame: 99, longestGameRounds: 99999,
        highestFeuerwerkTurnScore: 999999, highestX2TurnScore: 999999,
        isDefaultGame: false,
      });

      const after = await database.getGlobalStats();
      expect(after.highestTurnScore).toBe(before.highestTurnScore);
      expect(after.fastestWinTurns).toBe(before.fastestWinTurns);
      expect(after.fastestLossTurns).toBe(before.fastestLossTurns);
      expect(after.mostPlayersInGame).toBe(before.mostPlayersInGame);
      expect(after.longestGameRounds).toBe(before.longestGameRounds);
      expect(after.highestFeuerwerkTurnScore).toBe(before.highestFeuerwerkTurnScore);
      expect(after.highestX2TurnScore).toBe(before.highestX2TurnScore);
    });

    it('reports the same missing-row failure the normal path does', async () => {
      // The custom branch returns early — without its own guard it would
      // silently "succeed" against a database that was never migrated.
      await database.knex('global_statistics').where({ ruleset: 'modernized' }).del();
      await expect(database.updateGlobalStats({ gamesPlayed: 1, isDefaultGame: false }))
        .rejects.toThrow('global_statistics row missing');

      await database.knex('global_statistics').insert({ ruleset: 'modernized' });
    });

    it('the normal path itself refuses to succeed against a missing row', async () => {
      // The test above is named for this one and never exercised it: it only
      // ever took the custom-game early return. The full update path ends in
      // `changes === 0` — an UPDATE that matched nothing, which knex reports
      // as success — and a server whose migrations never ran would otherwise
      // accept and discard every game it was ever sent.
      await database.knex('global_statistics').where({ ruleset: 'modernized' }).del();

      await expect(database.updateGlobalStats({
        gamesPlayed: 1, totalScore: 500, highestTurnScore: 1500, isDefaultGame: true,
      })).rejects.toThrow('global_statistics row missing');

      await database.knex('global_statistics').insert({ ruleset: 'modernized' });
    });
  });

  it('should track currentWinStreak/bestWinStreak across consecutive wins, a loss reset, and a longer streak', async () => {
    const mockDeviceId = 'win-streak-device-' + Date.now();

    // Win #1
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 1 });
    let stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.currentWinStreak).toBe(1);
    expect(stats.bestWinStreak).toBe(1);

    // Win #2 — streak continues
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 1 });
    stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.currentWinStreak).toBe(2);
    expect(stats.bestWinStreak).toBe(2);

    // Loss — streak resets, best is preserved
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 0 });
    stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.currentWinStreak).toBe(0);
    expect(stats.bestWinStreak).toBe(2);

    // Three more wins — a new, longer streak becomes the new best
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 1 });
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 1 });
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 1 });
    stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.currentWinStreak).toBe(3);
    expect(stats.bestWinStreak).toBe(3);
  });

  // The insert path read `wins` as truthy and the merge path required exactly
  // 1, so the same payload meant different things depending on whether the row
  // already existed: a device's FIRST game with wins: 2 started a streak of 1,
  // and every later one reset the streak to 0. Only an out-of-band adjustment
  // (the token-gated POST /api/stats/:deviceId) ever sends a value other than
  // 0 or 1, so this is a self-contradiction rather than a live miscount — but
  // the two halves must not disagree about what a win is.
  it('agrees with itself about what counts as a win, on insert and on merge', async () => {
    const deviceId = 'test-streak-agreement-' + Date.now();

    // First write CREATES the row: the insert path decides the streak.
    await database.updateDeviceStats(deviceId, { gamesPlayed: 1, wins: 2 });
    const afterInsert = (await database.getDeviceStats(deviceId)).currentWinStreak;

    // Second write MERGES into it: the CASE expression decides.
    await database.updateDeviceStats(deviceId, { gamesPlayed: 1, wins: 2 });
    const afterMerge = (await database.getDeviceStats(deviceId)).currentWinStreak;

    expect(afterMerge, 'a second win continues the streak the first one started')
      .toBe(afterInsert + 1);
  });

  it('preserves the win streak on a partial update that records no game result', async () => {
    const mockDeviceId = 'partial-update-streak-device-' + Date.now();

    // Two wins build a streak of 2.
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 1 });
    await database.updateDeviceStats(mockDeviceId, { gamesPlayed: 1, wins: 1 });

    // A partial update without a `wins` key (e.g. an admin POST adjusting
    // totalPlaytime alone) must not reset the streak — only a payload that
    // actually records a game result may touch it.
    await database.updateDeviceStats(mockDeviceId, { totalPlaytime: 100 });

    const stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.currentWinStreak).toBe(2);
    expect(stats.bestWinStreak).toBe(2);
    expect(stats.totalPlaytime).toBe(100);
  });

  it('creates a fresh row with a zero streak when the first update is partial', async () => {
    const mockDeviceId = 'partial-first-update-device-' + Date.now();
    await database.updateDeviceStats(mockDeviceId, { totalPlaytime: 50 });
    const stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.currentWinStreak).toBe(0);
    expect(stats.bestWinStreak).toBe(0);
  });

  it('should handle edge cases with missing fields gracefully in device stats', async () => {
    const mockDeviceId = 'edge-case-device-' + Date.now();
    const almostEmptyStats = { dummy: 1 }; // Needs at least one key to bypass the early return optimization

    // Should not throw
    await database.updateDeviceStats(mockDeviceId, almostEmptyStats);

    const retrievedStats = await database.getDeviceStats(mockDeviceId);
    expect(retrievedStats).not.toBeNull();
    expect(retrievedStats.gamesPlayed).toBe(0);
    expect(retrievedStats.wins).toBe(0);
    expect(retrievedStats.totalPlaytime).toBe(0);
    expect(retrievedStats.totalTurns).toBe(0);
    expect(retrievedStats.kleeblattCompleted).toBe(0);
  });

  it('should handle edge cases with missing fields gracefully in global stats', async () => {
    const emptyGlobalStats = {}; // Missing all fields

    const initialStats = await database.getGlobalStats() || { totalGamesPlayed: 0, totalScore: 0 };
    
    // Should not throw
    await database.updateGlobalStats(emptyGlobalStats);

    const retrievedStats = await database.getGlobalStats();
    expect(retrievedStats).not.toBeNull();
    // Values should remain unchanged because they fall back to 0
    expect(retrievedStats.totalGamesPlayed).toBe(initialStats.totalGamesPlayed);
    expect(retrievedStats.totalScore).toBe(initialStats.totalScore);
  });

  it('should store and retrieve the new game-level stats (players, rounds, feuerwerk/x2 turn maxima) for a device', async () => {
    const mockDeviceId = 'game-stats-device-' + Date.now();

    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      totalPlayersSum: 4,
      mostPlayersInGame: 4,
      totalRoundsSum: 12,
      longestGameRounds: 12,
      highestFeuerwerkTurnScore: 300,
      highestX2TurnScore: 400,
    });

    const stats = await database.getDeviceStats(mockDeviceId);
    expect(stats.totalPlayersSum).toBe(4);
    expect(stats.mostPlayersInGame).toBe(4);
    expect(stats.totalRoundsSum).toBe(12);
    expect(stats.longestGameRounds).toBe(12);
    expect(stats.highestFeuerwerkTurnScore).toBe(300);
    expect(stats.highestX2TurnScore).toBe(400);
  });

  it('should store and retrieve the new game-level stats for global stats', async () => {
    await database.updateGlobalStats({
      gamesPlayed: 1,
      totalPlayersSum: 3,
      mostPlayersInGame: 3,
      totalRoundsSum: 9,
      longestGameRounds: 9,
      highestFeuerwerkTurnScore: 250,
      highestX2TurnScore: 350,
    });

    const stats = await database.getGlobalStats();
    expect(stats.totalPlayersSum).toBeGreaterThanOrEqual(3);
    expect(stats.mostPlayersInGame).toBeGreaterThanOrEqual(3);
    expect(stats.totalRoundsSum).toBeGreaterThanOrEqual(9);
    expect(stats.longestGameRounds).toBeGreaterThanOrEqual(9);
    expect(stats.highestFeuerwerkTurnScore).toBeGreaterThanOrEqual(250);
    expect(stats.highestX2TurnScore).toBeGreaterThanOrEqual(350);
  });

  it('should correctly accumulate values on multiple updates for global stats', async () => {
    const initialStats = await database.getGlobalStats() || { totalGamesPlayed: 0, totalScore: 0, totalBusts: 0 };
    
    const incrementalStats = {
      gamesPlayed: 1,
      totalScore: 5000,
      totalBusts: 2
    };

    // First update
    await database.updateGlobalStats(incrementalStats);
    // Second update
    await database.updateGlobalStats(incrementalStats);

    const retrievedStats = await database.getGlobalStats();
    expect(retrievedStats.totalGamesPlayed).toBe(initialStats.totalGamesPlayed + 2);
    expect(retrievedStats.totalScore).toBe(initialStats.totalScore + 10000);
    expect(retrievedStats.totalBusts).toBe(initialStats.totalBusts + 4);
  });

  describe('classic buckets and the per-ruleset global rows', () => {
    it('keeps the four device buckets independent', async () => {
      const dev = 'classic-bucket-dev-' + Date.now();
      await database.updateDeviceStats(dev, { gamesPlayed: 1, totalScore: 100 }, 'classic');
      await database.updateDeviceStats(dev, { gamesPlayed: 2, totalScore: 200 }, 'classic_custom');
      expect((await database.getDeviceStats(dev, 'classic'))?.totalScore).toBe(100);
      expect((await database.getDeviceStats(dev, 'classic_custom'))?.totalScore).toBe(200);
      expect(await database.getDeviceStats(dev)).toBeNull();
      expect(await database.getDeviceStats(dev, 'custom')).toBeNull();
    });

    it('sums totalTuttos and treats the chain records as null-safe MAX columns', async () => {
      const dev = 'classic-records-dev-' + Date.now();
      await database.updateDeviceStats(dev, { gamesPlayed: 1, totalTuttos: 2, mostCardsInTurn: 3 }, 'classic');
      await database.updateDeviceStats(dev, { gamesPlayed: 1, totalTuttos: 1, mostCardsInTurn: null, highestForfeitedTurnScore: 900 }, 'classic');
      const row = await database.getDeviceStats(dev, 'classic');
      expect(row?.totalTuttos).toBe(3);
      // A null in a later payload must not wipe the stored best.
      expect(row?.mostCardsInTurn).toBe(3);
      expect(row?.highestForfeitedTurnScore).toBe(900);
    });

    it('seeds both global rows and keeps their sums apart', async () => {
      const modernized = await database.getGlobalStats();
      const classic = await database.getGlobalStats('classic');
      expect(modernized?.ruleset).toBe('modernized');
      expect(classic?.ruleset).toBe('classic');

      const classicGamesBefore = classic!.totalGamesPlayed;
      const modernizedGamesBefore = modernized!.totalGamesPlayed;
      await database.updateGlobalStats({ gamesPlayed: 1, totalTuttos: 5, isDefaultGame: true }, 'classic');
      const classicAfter = await database.getGlobalStats('classic');
      expect(classicAfter?.totalGamesPlayed).toBe(classicGamesBefore + 1);
      expect(classicAfter?.totalTuttos).toBe((classic?.totalTuttos ?? 0) + 5);
      expect((await database.getGlobalStats())?.totalGamesPlayed).toBe(modernizedGamesBefore);
    });

    it('a custom classic game bumps only the classic row, and only its custom counter', async () => {
      const classicBefore = await database.getGlobalStats('classic');
      const modernizedBefore = await database.getGlobalStats();
      await database.updateGlobalStats({ gamesPlayed: 1, totalScore: 999, isDefaultGame: false }, 'classic');
      const classicAfter = await database.getGlobalStats('classic');
      expect(classicAfter?.customGamesPlayed).toBe((classicBefore?.customGamesPlayed ?? 0) + 1);
      expect(classicAfter?.totalScore).toBe(classicBefore?.totalScore);
      expect((await database.getGlobalStats())?.customGamesPlayed).toBe(modernizedBefore?.customGamesPlayed);
    });
  });

  // Both scopes keep the same records with the same aggregate, and the device
  // and global paths used to spell that list out separately — so a column added
  // to one and forgotten in the other simply stopped being a record there, with
  // nothing to say so. These cases are generated FROM the shared list, so a new
  // column is covered in both scopes the moment it is added to it.
  describe.each(RECORD_COLUMNS)('the %s record is kept by both scopes', (column, aggregate) => {
    // A worse value than `best` for this aggregate, and a better one.
    const best = aggregate === 'MAX' ? 900 : 3;
    const worse = aggregate === 'MAX' ? 100 : 30;
    const better = aggregate === 'MAX' ? 1500 : 1;

    it('survives a worse value and yields to a better one, per device', async () => {
      const deviceId = `record-${column}-${Date.now()}`;
      await database.updateDeviceStats(deviceId, { [column]: best });
      await database.updateDeviceStats(deviceId, { [column]: worse });
      expect((await database.getDeviceStats(deviceId))?.[column]).toBe(best);

      await database.updateDeviceStats(deviceId, { [column]: better });
      expect((await database.getDeviceStats(deviceId))?.[column]).toBe(better);
    });

    it('survives a worse value and yields to a better one, globally', async () => {
      // The global row is shared by the whole suite, so this measures against
      // whatever is already recorded rather than assuming a clean slate.
      const startingValue = (await database.getGlobalStats())?.[column] ?? null;
      const keeps = (candidate: number, stored: number | null): number =>
        stored === null ? candidate : (aggregate === 'MAX' ? Math.max(candidate, stored) : Math.min(candidate, stored));

      await database.updateGlobalStats({ [column]: worse });
      expect((await database.getGlobalStats())?.[column]).toBe(keeps(worse, startingValue));

      await database.updateGlobalStats({ [column]: better });
      expect((await database.getGlobalStats())?.[column]).toBe(keeps(better, keeps(worse, startingValue)));
    });

    it('is never wiped by a null, in either scope', async () => {
      const deviceId = `record-null-${column}-${Date.now()}`;
      await database.updateDeviceStats(deviceId, { [column]: best });
      await database.updateDeviceStats(deviceId, { [column]: null });
      expect((await database.getDeviceStats(deviceId))?.[column]).toBe(best);

      const globalBefore = (await database.getGlobalStats())?.[column];
      await database.updateGlobalStats({ [column]: null });
      expect((await database.getGlobalStats())?.[column]).toBe(globalBefore);
    });
  });
});
