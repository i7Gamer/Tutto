process.env.TEST_DB = 'true';

import { describe, it, expect, beforeAll } from 'vitest';
import database from './database';

describe('Database Statistics Integration', () => {
  beforeAll(async () => {
    await database.initDb();
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
