process.env.TEST_DB = 'true';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import database from './database';

describe('Database Statistics Integration', () => {
  beforeAll(async () => {
    await database.initDb();
  });

  afterAll(async () => {
    await database.knex.destroy();
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
});
