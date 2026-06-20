import { describe, it, expect } from 'vitest';
import database from './database';

describe('Database Statistics Integration', () => {
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
  });
});
