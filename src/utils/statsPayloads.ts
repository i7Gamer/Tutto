import type { Player, GlobalStatsPayload, DeviceStatsPayload } from '../types';
import { getLeaders } from './coreGameEngine';

/**
 * One device's own row for a finished game, from that game's final state.
 *
 * Pulled out of sendOnlineStats so the integration suite can assert against
 * the payload the app actually sends. Its hand-copied duplicate had already
 * drifted: it was missing totalTuttos and both classic records, and still used
 * the superseded fastestLossTurns rule — the one without the `totalTurns > 0`
 * guard, which records a 0-turn "fastest loss" for a seat the game ended
 * before, and MIN-merges it into a record with no way back.
 *
 * Returns null when this device holds no seat, which is sendOnlineStats' own
 * guard: there is nothing to record.
 */
export const buildDeviceStatsPayload = (
  finalPlayers: Player[],
  myName: string | null,
  finalTime: number,
  finalRound: number,
): DeviceStatsPayload | null => {
  const me = finalPlayers.find(p => p.name === myName);
  if (!me) return null;
  const didIWin = getLeaders(finalPlayers).some(l => l.name === me.name) ? 1 : 0;

  return {
    gamesPlayed: 1, wins: didIWin, totalPlaytime: finalTime || 0,
    pointsDeducted: me.times1000PointsDeducted || 0, plusMinusCompleted: me.timesPlusMinusCompleted || 0,
    plusMinusFailed: me.timesPlusMinusFailed || 0, kniffelCompleted: me.timesKniffelCompleted || 0,
    kniffelFailed: me.timesKniffelFailed || 0, skipped: me.timesSkipped || 0,
    feuerwerkReceived: me.timesFeuerwerkReceived || 0, kleeblattFailed: me.timesKleeblattFailed || 0,
    kleeblattCompleted: me.timesKleeblattCompleted || 0, x2Received: me.timesx2Received || 0,
    totalTurns: me.totalTurns || 0, busts: me.busts || 0,
    feuerwerkBusts: me.feuerwerkBusts || 0, x2Busts: me.x2Busts || 0,
    feuerwerkPointsScored: me.feuerwerkPointsScored || 0, x2PointsScored: me.x2PointsScored || 0,
    totalTuttos: me.totalTuttos || 0,
    highestTurnScore: me.highestTurnScore || 0, totalScore: me.score || 0,
    fastestWinTurns: didIWin ? (me.totalTurns || 0) : null,
    // null, not 0, when this device never got a turn — a game can end
    // mid-round (a completed Kleeblatt wins instantly), so a player later in
    // the turn order can finish on 0. sanitize.ts now DROPS a non-positive
    // value for this field rather than clamping it up to 1, so sending 0
    // would simply vanish instead of stating the "no record" outcome the way
    // null does. See buildGlobalStatsPayload for the same rule globally.
    fastestLossTurns: !didIWin && (me.totalTurns || 0) > 0 ? me.totalTurns : null,
    totalPlayersSum: finalPlayers.length, mostPlayersInGame: finalPlayers.length,
    totalRoundsSum: finalRound || 0, longestGameRounds: finalRound || 0,
    highestFeuerwerkTurnScore: me.highestFeuerwerkTurnScore || 0,
    highestX2TurnScore: me.highestX2TurnScore || 0,
    // Classic-only records: OMITTED (not sent as 0) when unset —
    // updateDeviceStats writes the incoming value on row insert, and a 0 would
    // permanently stamp itself where NULL ("no record yet") belongs.
    ...(me.mostCardsInTurn !== undefined ? { mostCardsInTurn: me.mostCardsInTurn } : {}),
    ...(me.highestForfeitedTurnScore !== undefined ? { highestForfeitedTurnScore: me.highestForfeitedTurnScore } : {}),
  };
};

export const buildGlobalStatsPayload = (
  finalPlayers: Player[],
  finalTime: number,
  isDefaultGame: boolean,
  finalRound: number,
): GlobalStatsPayload => {
  let totalPlusMinus = 0;
  let totalKniffel = 0;
  let totalStop = 0;
  let totalFeuerwerk = 0;
  let totalKleeblatt = 0;
  let totalKleeblattCompleted = 0;
  let totalx2 = 0;
  let totalTurns = 0;
  let totalScore = 0;
  let totalPlusMinusCompleted = 0;
  let totalKniffelCompleted = 0;
  let totalFeuerwerkPoints = 0;
  let totalx2Points = 0;
  let totalFeuerwerkBusts = 0;
  let totalx2Busts = 0;
  let totalBusts = 0;
  let totalTuttos = 0;
  let highestTurnScore = 0;
  let highestFeuerwerkTurnScore = 0;
  let highestX2TurnScore = 0;
  let mostCardsInTurn: number | null = null;
  let highestForfeitedTurnScore: number | null = null;
  let fastestWinTurns: number | null = null;
  let fastestLossTurns: number | null = null;

  const leaders = getLeaders(finalPlayers);
  const isWinner = (p: Player) => leaders.some(l => l.name === p.name);

  finalPlayers.forEach(p => {
    totalPlusMinus += ((p.timesPlusMinusCompleted ?? 0) + (p.timesPlusMinusFailed ?? 0));
    totalKniffel += ((p.timesKniffelCompleted ?? 0) + (p.timesKniffelFailed ?? 0));
    totalStop += (p.timesSkipped ?? 0);
    totalFeuerwerk += (p.timesFeuerwerkReceived ?? 0);
    totalKleeblatt += ((p.timesKleeblattFailed ?? 0) + (p.timesKleeblattCompleted ?? 0));
    totalKleeblattCompleted += (p.timesKleeblattCompleted ?? 0);
    totalx2 += (p.timesx2Received ?? 0);
    totalTurns += (p.totalTurns ?? 0);
    totalScore += (p.score ?? 0);
    totalPlusMinusCompleted += (p.timesPlusMinusCompleted ?? 0);
    totalKniffelCompleted += (p.timesKniffelCompleted ?? 0);
    totalFeuerwerkPoints += (p.feuerwerkPointsScored ?? 0);
    totalx2Points += (p.x2PointsScored ?? 0);
    totalFeuerwerkBusts += (p.feuerwerkBusts ?? 0);
    totalx2Busts += (p.x2Busts ?? 0);
    totalBusts += (p.busts ?? 0);
    totalTuttos += (p.totalTuttos ?? 0);
    if (p.mostCardsInTurn !== undefined && (mostCardsInTurn === null || p.mostCardsInTurn > mostCardsInTurn)) {
      mostCardsInTurn = p.mostCardsInTurn;
    }
    if (p.highestForfeitedTurnScore !== undefined && (highestForfeitedTurnScore === null || p.highestForfeitedTurnScore > highestForfeitedTurnScore)) {
      highestForfeitedTurnScore = p.highestForfeitedTurnScore;
    }
    if ((p.highestTurnScore ?? 0) > highestTurnScore) {
      highestTurnScore = p.highestTurnScore ?? 0;
    }
    if ((p.highestFeuerwerkTurnScore ?? 0) > highestFeuerwerkTurnScore) {
      highestFeuerwerkTurnScore = p.highestFeuerwerkTurnScore ?? 0;
    }
    if ((p.highestX2TurnScore ?? 0) > highestX2TurnScore) {
      highestX2TurnScore = p.highestX2TurnScore ?? 0;
    }
    if (isWinner(p)) {
      if (fastestWinTurns === null || p.totalTurns < fastestWinTurns) {
        fastestWinTurns = p.totalTurns;
      }
    } else if (p.totalTurns > 0) {
      // Zero turns is not a fast loss, it is no game played: a completed
      // Kleeblatt wins instantly and can end the game mid-round, leaving
      // players later in the turn order on 0. This `> 0` guard keeps it out of
      // the running altogether — sanitize.ts would now DROP a 0 sent for
      // fastestLossTurns anyway (rather than clamping it up to 1), but relying
      // on that instead of this guard would still let a stray 0 win the `<`
      // comparison above before ever reaching sanitize.
      if (fastestLossTurns === null || p.totalTurns < fastestLossTurns) {
        fastestLossTurns = p.totalTurns;
      }
    }
  });

  return {
    gamesPlayed: 1, totalPlaytime: finalTime,
    totalPlusMinus, totalKniffel, totalStop, totalFeuerwerk,
    totalKleeblatt, totalKleeblattCompleted, totalx2,
    totalTurns, totalScore, totalPlusMinusCompleted, totalKniffelCompleted,
    totalFeuerwerkPoints, totalx2Points, totalFeuerwerkBusts, totalx2Busts, totalBusts,
    highestTurnScore, fastestWinTurns, fastestLossTurns, isDefaultGame,
    totalPlayersSum: finalPlayers.length, mostPlayersInGame: finalPlayers.length,
    totalRoundsSum: finalRound, longestGameRounds: finalRound,
    highestFeuerwerkTurnScore, highestX2TurnScore,
    totalTuttos, mostCardsInTurn, highestForfeitedTurnScore,
  };
};
