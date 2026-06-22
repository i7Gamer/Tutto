import { describe, it, expect } from 'vitest';
import { getLeaders, buildGlobalStatsPayload, shuffleArray } from './coreGameEngine';

describe('coreGameEngine', () => {
  describe('shuffleArray', () => {
    it('returns an array of the same length with same elements', () => {
      const arr = [1, 2, 3, 4, 5];
      const shuffled = shuffleArray(arr);
      expect(shuffled.length).toBe(arr.length);
      expect([...shuffled].sort()).toEqual([...arr].sort());
      expect(shuffled).not.toBe(arr); // should be a new array
    });
  });

  describe('getLeaders', () => {
    it('returns an empty array if no players', () => {
      expect(getLeaders([])).toEqual([]);
    });

    it('returns the player with the highest score', () => {
      const players = [{ name: 'A', score: 100 }, { name: 'B', score: 200 }];
      expect(getLeaders(players)).toEqual([{ name: 'B', score: 200 }]);
    });

    it('returns multiple players if there is a tie for the highest score', () => {
      const players = [
        { name: 'A', score: 200 },
        { name: 'B', score: 200 },
        { name: 'C', score: 100 }
      ];
      expect(getLeaders(players)).toEqual([
        { name: 'A', score: 200 },
        { name: 'B', score: 200 }
      ]);
    });
  });

  describe('buildGlobalStatsPayload', () => {
    it('correctly aggregates stats from multiple players', () => {
      const finalPlayers = [
        {
          timesPlusMinusCompleted: 1, timesPlusMinusFailed: 1,
          timesKniffelCompleted: 1, timesKniffelFailed: 0,
          timesSkipped: 2, timesFeuerwerkReceived: 1,
          timesKleeblattFailed: 1, timesKleeblattCompleted: 0,
          timesx2Received: 2, totalTurns: 5, score: 3000,
          feuerwerkPointsScored: 500, x2PointsScored: 800,
          feuerwerkBusts: 1, x2Busts: 1, busts: 2
        },
        {
          timesPlusMinusCompleted: 0, timesPlusMinusFailed: 0,
          timesKniffelCompleted: 0, timesKniffelFailed: 0,
          timesSkipped: 0, timesFeuerwerkReceived: 0,
          timesKleeblattFailed: 0, timesKleeblattCompleted: 0,
          timesx2Received: 0, totalTurns: 3, score: 1000,
          feuerwerkPointsScored: 0, x2PointsScored: 0,
          feuerwerkBusts: 0, x2Busts: 0, busts: 1
        }
      ];

      const payload = buildGlobalStatsPayload(finalPlayers, 120, true);

      expect(payload).toEqual({
        gamesPlayed: 1,
        totalPlaytime: 120,
        totalPlusMinus: 2,
        totalKniffel: 1,
        totalStop: 2,
        totalFeuerwerk: 1,
        totalKleeblatt: 1,
        totalKleeblattCompleted: 0,
        totalx2: 2,
        totalTurns: 8,
        totalScore: 4000,
        totalPlusMinusCompleted: 1,
        totalKniffelCompleted: 1,
        totalFeuerwerkPoints: 500,
        totalx2Points: 800,
        totalFeuerwerkBusts: 1,
        totalx2Busts: 1,
        totalBusts: 3,
        highestTurnScore: 0,
        fastestWinTurns: 3,
        isDefaultGame: true
      });
    });
  });
});
