/** @vitest-environment node */
process.env.TEST_DB = 'true';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import database from './database';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import { nonNull } from '../src/testing/factories';

describe('Statistics Saving - Personal and Global', () => {
  beforeAll(async () => {
    await database.initDb();
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await database.knex.destroy();
  });

  describe('Personal Statistics Saving', () => {
    it('should save personal stats for a device after a game', async () => {
      const deviceId = 'device-' + Date.now();

      const personalStats = {
        gamesPlayed: 1,
        wins: 1,
        totalPlaytime: 450,
        totalTurns: 15,
        busts: 2,
        highestTurnScore: 500,
        fastestWinTurns: 15,
        fastestLossTurns: null,
        pointsDeducted: 0,
        plusMinusCompleted: 1,
        plusMinusFailed: 0,
        kniffelCompleted: 1,
        kniffelFailed: 0,
        skipped: 2,
        feuerwerkReceived: 1,
        feuerwerkBusts: 0,
        feuerwerkPointsScored: 800,
        kleeblattCompleted: 0,
        kleeblattFailed: 0,
        x2Received: 1,
        x2Busts: 0,
        x2PointsScored: 1200
      };

      await database.updateDeviceStats(deviceId, personalStats);
      const saved = nonNull(await database.getDeviceStats(deviceId));

      expect(saved.deviceId).toBe(deviceId);
      expect(saved.gamesPlayed).toBe(1);
      expect(saved.wins).toBe(1);
      expect(saved.totalPlaytime).toBe(450);
      expect(saved.totalTurns).toBe(15);
      expect(saved.busts).toBe(2);
      expect(saved.highestTurnScore).toBe(500);
      expect(saved.fastestWinTurns).toBe(15);
      expect(saved.fastestLossTurns).toBeNull();
    });

    it('should accumulate personal stats across multiple games', async () => {
      const deviceId = 'device-multi-' + Date.now();

      const game1Stats = {
        gamesPlayed: 1,
        wins: 1,
        totalPlaytime: 300,
        totalTurns: 10,
        busts: 1,
        highestTurnScore: 400,
        fastestWinTurns: 10,
        totalScore: 6100
      };

      const game2Stats = {
        gamesPlayed: 1,
        wins: 0,
        totalPlaytime: 250,
        totalTurns: 8,
        busts: 2,
        highestTurnScore: 350,
        fastestLossTurns: 8,
        totalScore: 4500
      };

      // First game
      await database.updateDeviceStats(deviceId, game1Stats);
      let saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.gamesPlayed).toBe(1);
      expect(saved.wins).toBe(1);
      expect(saved.totalPlaytime).toBe(300);
      expect(saved.totalTurns).toBe(10);
      expect(saved.fastestWinTurns).toBe(10);

      // Second game
      await database.updateDeviceStats(deviceId, game2Stats);
      saved = nonNull(await database.getDeviceStats(deviceId));

      expect(saved.gamesPlayed).toBe(2);
      expect(saved.wins).toBe(1);
      expect(saved.totalPlaytime).toBe(550);
      expect(saved.totalTurns).toBe(18);
      expect(saved.busts).toBe(3);
      expect(saved.fastestWinTurns).toBe(10);
      expect(saved.fastestLossTurns).toBe(8);
      expect(saved.highestTurnScore).toBe(400);
    });
  });

  describe('Global Statistics Saving', () => {
    it('should save global stats after a game', async () => {
      const globalStats = {
        gamesPlayed: 1,
        totalPlaytime: 600,
        totalPlusMinus: 2,
        totalKniffel: 3,
        totalStop: 4,
        totalFeuerwerk: 2,
        totalKleeblatt: 1,
        totalKleeblattCompleted: 1,
        totalx2: 2,
        totalTurns: 25,
        totalScore: 8000,
        totalPlusMinusCompleted: 1,
        totalKniffelCompleted: 2,
        totalFeuerwerkPoints: 1500,
        totalx2Points: 1800,
        totalFeuerwerkBusts: 0,
        totalx2Busts: 0,
        totalBusts: 3,
        highestTurnScore: 600,
        fastestWinTurns: 25,
        isDefaultGame: true
      };

      await database.updateGlobalStats(globalStats);
      const saved = nonNull(await database.getGlobalStats());

      expect(saved.totalGamesPlayed).toBe(1);
      expect(saved.totalPlaytime).toBe(600);
      expect(saved.totalPlusMinus).toBe(2);
      expect(saved.totalKniffel).toBe(3);
      expect(saved.totalStop).toBe(4);
      expect(saved.totalFeuerwerk).toBe(2);
      expect(saved.totalKleeblatt).toBe(1);
      expect(saved.totalKleeblattCompleted).toBe(1);
      expect(saved.totalTurns).toBe(25);
      expect(saved.totalScore).toBe(8000);
      expect(saved.highestTurnScore).toBe(600);
      expect(saved.fastestWinTurns).toBe(25);
    });

    it('should accumulate global stats across multiple games', async () => {
      const game1Global = {
        gamesPlayed: 1,
        totalPlaytime: 400,
        totalScore: 5000,
        totalTurns: 18,
        totalBusts: 2,
        highestTurnScore: 450,
        isDefaultGame: true
      };

      const game2Global = {
        gamesPlayed: 1,
        totalPlaytime: 350,
        totalScore: 6000,
        totalTurns: 20,
        totalBusts: 1,
        highestTurnScore: 550,
        isDefaultGame: true
      };

      // Save first game global stats
      await database.updateGlobalStats(game1Global);
      let saved = nonNull(await database.getGlobalStats());
      const afterGame1 = { ...saved };

      // Save second game global stats
      await database.updateGlobalStats(game2Global);
      saved = nonNull(await database.getGlobalStats());

      expect(saved.totalGamesPlayed).toBe(afterGame1.totalGamesPlayed + 1);
      expect(saved.totalPlaytime).toBe(afterGame1.totalPlaytime + 350);
      expect(saved.totalScore).toBe(afterGame1.totalScore + 6000);
      expect(saved.totalTurns).toBe(afterGame1.totalTurns + 20);
      expect(saved.totalBusts).toBe(afterGame1.totalBusts + 1);
      // highestTurnScore should be the MAX of the two, which is 550
      expect(saved.highestTurnScore).toBe(Math.max(nonNull(afterGame1.highestTurnScore), 550));
    });
  });

  describe('Personal + Global Stats Together', () => {
    it('should save both personal and global stats from a single game', async () => {
      const deviceId = 'device-complete-' + Date.now();

      const personalStats = {
        gamesPlayed: 1,
        wins: 1,
        totalPlaytime: 500,
        totalTurns: 20,
        busts: 2,
        highestTurnScore: 550,
        fastestWinTurns: 20,
        pointsDeducted: 0,
        plusMinusCompleted: 2,
        kniffelCompleted: 1,
        skipped: 3,
        feuerwerkReceived: 1,
        feuerwerkBusts: 0,
        feuerwerkPointsScored: 900,
        x2Received: 1,
        x2Busts: 0,
        x2PointsScored: 1400,
        kleeblattCompleted: 0,
        kleeblattFailed: 0,
        totalScore: 7000
      };

      const globalStats = {
        gamesPlayed: 1,
        totalPlaytime: 500,
        totalPlusMinus: 2,
        totalKniffel: 1,
        totalPlusMinusCompleted: 2,
        totalKniffelCompleted: 1,
        totalStop: 3,
        totalFeuerwerk: 1,
        totalx2: 1,
        totalTurns: 20,
        totalScore: 7000,
        totalBusts: 2,
        highestTurnScore: 550,
        fastestWinTurns: 20,
        feuerwerkPointsScored: 900,
        x2PointsScored: 1400,
        isDefaultGame: true
      };

      // Save both
      await database.updateDeviceStats(deviceId, personalStats);
      await database.updateGlobalStats(globalStats);

      // Verify personal stats
      const savedPersonal = nonNull(await database.getDeviceStats(deviceId));
      expect(savedPersonal.gamesPlayed).toBe(1);
      expect(savedPersonal.wins).toBe(1);
      expect(savedPersonal.totalPlaytime).toBe(500);
      expect(savedPersonal.plusMinusCompleted).toBe(2);
      expect(savedPersonal.feuerwerkPointsScored).toBe(900);

      // Verify global stats
      const savedGlobal = nonNull(await database.getGlobalStats());
      expect(savedGlobal.totalGamesPlayed).toBeGreaterThanOrEqual(1);
      expect(savedGlobal.totalTurns).toBeGreaterThanOrEqual(20);
      expect(savedGlobal.totalScore).toBeGreaterThanOrEqual(7000);
      expect(savedGlobal.totalBusts).toBeGreaterThanOrEqual(2);
    });

    it('should correctly track card-specific stats in both personal and global', async () => {
      const deviceId = 'device-cards-' + Date.now();

      const personalCardStats = {
        gamesPlayed: 1,
        plusMinusCompleted: 1,
        plusMinusFailed: 1,
        kniffelCompleted: 2,
        kniffelFailed: 1,
        kleeblattCompleted: 0,
        kleeblattFailed: 1,
        skipped: 2,
        feuerwerkReceived: 1,
        feuerwerkBusts: 1,
        x2Received: 1,
        x2Busts: 0
      };

      const globalCardStats = {
        gamesPlayed: 1,
        totalPlusMinus: 2,
        totalPlusMinusCompleted: 1,
        totalKniffel: 3,
        totalKniffelCompleted: 2,
        totalKleeblatt: 1,
        totalKleeblattCompleted: 0,
        totalStop: 2,
        totalFeuerwerk: 1,
        totalFeuerwerkBusts: 1,
        totalx2: 1,
        totalx2Busts: 0,
        isDefaultGame: true
      };

      await database.updateDeviceStats(deviceId, personalCardStats);
      await database.updateGlobalStats(globalCardStats);

      const savedPersonal = nonNull(await database.getDeviceStats(deviceId));
      expect(savedPersonal.plusMinusCompleted).toBe(1);
      expect(savedPersonal.plusMinusFailed).toBe(1);
      expect(savedPersonal.kniffelCompleted).toBe(2);
      expect(savedPersonal.kniffelFailed).toBe(1);
      expect(savedPersonal.kleeblattFailed).toBe(1);
      expect(savedPersonal.kleeblattCompleted).toBe(0);

      const savedGlobal = nonNull(await database.getGlobalStats());
      expect(savedGlobal.totalPlusMinusCompleted).toBeGreaterThanOrEqual(1);
      expect(savedGlobal.totalKniffelCompleted).toBeGreaterThanOrEqual(2);
      expect(savedGlobal.totalStop).toBeGreaterThanOrEqual(2);
      expect(savedGlobal.totalFeuerwerkBusts).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Players-per-game / longest-game / feuerwerk-x2 turn stats', () => {
    it('should sum totalPlayersSum/totalRoundsSum and track mostPlayersInGame/longestGameRounds as running maxima for a device', async () => {
      const deviceId = 'device-game-stats-' + Date.now();

      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, totalPlayersSum: 3, mostPlayersInGame: 3, totalRoundsSum: 5, longestGameRounds: 5,
      });
      let saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.totalPlayersSum).toBe(3);
      expect(saved.mostPlayersInGame).toBe(3);
      expect(saved.totalRoundsSum).toBe(5);
      expect(saved.longestGameRounds).toBe(5);

      // A bigger game: sums add, maxima update.
      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, totalPlayersSum: 6, mostPlayersInGame: 6, totalRoundsSum: 9, longestGameRounds: 9,
      });
      saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.totalPlayersSum).toBe(9);
      expect(saved.mostPlayersInGame).toBe(6);
      expect(saved.totalRoundsSum).toBe(14);
      expect(saved.longestGameRounds).toBe(9);

      // A smaller game afterwards: sums keep adding, maxima stay put.
      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, totalPlayersSum: 2, mostPlayersInGame: 2, totalRoundsSum: 3, longestGameRounds: 3,
      });
      saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.totalPlayersSum).toBe(11);
      expect(saved.mostPlayersInGame).toBe(6);
      expect(saved.totalRoundsSum).toBe(17);
      expect(saved.longestGameRounds).toBe(9);
    });

    it('should track highestFeuerwerkTurnScore/highestX2TurnScore as running maxima for a device', async () => {
      const deviceId = 'device-firework-x2-' + Date.now();

      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, highestFeuerwerkTurnScore: 200, highestX2TurnScore: 300,
      });
      let saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.highestFeuerwerkTurnScore).toBe(200);
      expect(saved.highestX2TurnScore).toBe(300);

      // Lower this game — maxima must not regress.
      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, highestFeuerwerkTurnScore: 100, highestX2TurnScore: 150,
      });
      saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.highestFeuerwerkTurnScore).toBe(200);
      expect(saved.highestX2TurnScore).toBe(300);

      // A new record for both.
      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, highestFeuerwerkTurnScore: 500, highestX2TurnScore: 600,
      });
      saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.highestFeuerwerkTurnScore).toBe(500);
      expect(saved.highestX2TurnScore).toBe(600);
    });

    it('should not overwrite the new max-type stats with null, for both device and global', async () => {
      const deviceId = 'device-null-safe-game-stats-' + Date.now();

      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, mostPlayersInGame: 5, longestGameRounds: 10,
        highestFeuerwerkTurnScore: 300, highestX2TurnScore: 400,
      });
      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1, mostPlayersInGame: null, longestGameRounds: null,
        highestFeuerwerkTurnScore: null, highestX2TurnScore: null,
      });
      const saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.mostPlayersInGame).toBe(5);
      expect(saved.longestGameRounds).toBe(10);
      expect(saved.highestFeuerwerkTurnScore).toBe(300);
      expect(saved.highestX2TurnScore).toBe(400);

      await database.updateGlobalStats({
        gamesPlayed: 1, mostPlayersInGame: 5, longestGameRounds: 10,
        highestFeuerwerkTurnScore: 300, highestX2TurnScore: 400,
      });
      let globalSaved = nonNull(await database.getGlobalStats());
      const beforeNull = { ...globalSaved };

      await database.updateGlobalStats({
        gamesPlayed: 1, mostPlayersInGame: null, longestGameRounds: null,
        highestFeuerwerkTurnScore: null, highestX2TurnScore: null,
      });
      globalSaved = nonNull(await database.getGlobalStats());
      expect(globalSaved.mostPlayersInGame).toBe(beforeNull.mostPlayersInGame);
      expect(globalSaved.longestGameRounds).toBe(beforeNull.longestGameRounds);
      expect(globalSaved.highestFeuerwerkTurnScore).toBe(beforeNull.highestFeuerwerkTurnScore);
      expect(globalSaved.highestX2TurnScore).toBe(beforeNull.highestX2TurnScore);
    });

    it('should sum totalPlayersSum/totalRoundsSum and track maxima for global stats', async () => {
      const before = await database.getGlobalStats();

      await database.updateGlobalStats({
        gamesPlayed: 1, totalPlayersSum: 4, mostPlayersInGame: 4, totalRoundsSum: 8, longestGameRounds: 8,
        isDefaultGame: true,
      });
      const saved = nonNull(await database.getGlobalStats());
      expect(saved.totalPlayersSum).toBe((before?.totalPlayersSum ?? 0) + 4);
      expect(saved.totalRoundsSum).toBe((before?.totalRoundsSum ?? 0) + 8);
      expect(saved.mostPlayersInGame).toBeGreaterThanOrEqual(4);
      expect(saved.longestGameRounds).toBeGreaterThanOrEqual(8);
    });
  });

  describe('Statistics Persistence and Accuracy', () => {
    it('should not lose precision when accumulating large numbers', async () => {
      const deviceId = 'device-large-' + Date.now();

      const stats = {
        gamesPlayed: 100,
        totalScore: 600000,
        totalPlaytime: 50000,
        totalTurns: 2000
      };

      await database.updateDeviceStats(deviceId, stats);
      const saved = nonNull(await database.getDeviceStats(deviceId));

      expect(saved.gamesPlayed).toBe(100);
      expect(saved.totalScore).toBe(600000);
      expect(saved.totalPlaytime).toBe(50000);
      expect(saved.totalTurns).toBe(2000);
    });

    it('should handle zero values correctly', async () => {
      const deviceId = 'device-zeros-' + Date.now();

      const stats = {
        gamesPlayed: 1,
        wins: 0,
        busts: 0,
        kniffelCompleted: 0,
        feuerwerkBusts: 0,
        kleeblattCompleted: 0
      };

      await database.updateDeviceStats(deviceId, stats);
      const saved = nonNull(await database.getDeviceStats(deviceId));

      expect(saved.gamesPlayed).toBe(1);
      expect(saved.wins).toBe(0);
      expect(saved.busts).toBe(0);
      expect(saved.kniffelCompleted).toBe(0);
    });

    it('should correctly handle fastest stats (smallest wins)', async () => {
      const deviceId = 'device-fastest-' + Date.now();

      // First game: win in 15 turns
      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1,
        wins: 1,
        fastestWinTurns: 15
      });

      let saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.fastestWinTurns).toBe(15);

      // Second game: win in 8 turns (should update to fastest)
      await database.updateDeviceStats(deviceId, {
        gamesPlayed: 1,
        wins: 1,
        fastestWinTurns: 8
      });

      saved = nonNull(await database.getDeviceStats(deviceId));
      expect(saved.fastestWinTurns).toBe(8);
      expect(saved.wins).toBe(2);
    });
  });
});
