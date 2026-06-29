import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import database from './database';
import { useGameStore } from '../src/store/useGameStore';

// Force the test DB
process.env.TEST_DB = 'true';

describe('End-to-End Statistics Integration', () => {
  beforeAll(async () => {
    await database.initDb();
  });

  beforeEach(() => {
    useGameStore.getState().startGame(); // Just start to initialize the state cleanly if needed
    vi.useFakeTimers();
  });

  it('simulates multiple games and verifies all statistics aggregate perfectly in the database', async () => {
    const mockDeviceId = 'test-e2e-device-' + Date.now();
    
    // First, clear any store state manually
    useGameStore.setState({ players: [], finished: true });

    // ==========================================
    // GAME 1
    // ==========================================
    let store = useGameStore.getState();
    store.addPlayer('Alice');
    store.addPlayer('Bob');
    store.startGame();
    
    // Simulate real time passing (e.g. 50 seconds)
    vi.setSystemTime(Date.now() + 50000);

    // Turn 1: Alice gets Feuerwerk, scores 1000, but then busts
    store = useGameStore.getState();
    store.currentCard = 'Feuerwerk';
    store.nextTurn(1000, false);

    // Turn 2: Bob gets x2, scores 2000 successfully
    store = useGameStore.getState();
    store.currentCard = 'x2';
    store.nextTurn(2000, false);

    // Turn 3: Alice gets Plus/Minus and succeeds! Deducts 1000 from Bob.
    store = useGameStore.getState();
    store.currentCard = 'Plus_Minus';
    store.nextTurn(0, true);

    // Turn 4: Bob gets Stop (skipped)
    store = useGameStore.getState();
    store.currentCard = 'Stop';
    store.nextTurn(0, false);

    // Turn 5: Alice gets Kniffel and fails
    store = useGameStore.getState();
    store.currentCard = 'Kniffel';
    store.nextTurn(0, false);

    // Turn 6: Bob gets Kleeblatt and fails
    store = useGameStore.getState();
    store.currentCard = 'Kleeblatt';
    store.nextTurn(0, false);

    // Turn 7: Alice gets 200 card, scores 6000!
    store = useGameStore.getState();
    store.currentCard = '200';
    store.nextTurn(6000, false);

    // Turn 8: Bob must take his final turn because players get equal turns. Bob gets Stop.
    store = useGameStore.getState();
    store.currentCard = 'Stop';
    store.nextTurn(0, false);

    expect(useGameStore.getState().finished).toBe(true);

    const payload1 = useGameStore.getState().buildGlobalStatsPayload();
    await database.updateGlobalStats(payload1);
    
    const me1 = useGameStore.getState().players[0]; // Alice
    const didAliceWin1 = 1;
    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      wins: didAliceWin1,
      totalPlaytime: 50,
      pointsDeducted: me1.times1000PointsDeducted || 0,
      plusMinusCompleted: me1.timesPlusMinusCompleted || 0,
      plusMinusFailed: me1.timesPlusMinusFailed || 0,
      kniffelCompleted: me1.timesKniffelCompleted || 0,
      kniffelFailed: me1.timesKniffelFailed || 0,
      skipped: me1.timesSkipped || 0,
      feuerwerkReceived: me1.timesFeuerwerkReceived || 0,
      kleeblattFailed: me1.timesKleeblattFailed || 0,
      kleeblattCompleted: me1.timesKleeblattCompleted || 0,
      x2Received: me1.timesx2Received || 0,
      totalTurns: me1.totalTurns || 0,
      busts: me1.busts || 0,
      feuerwerkBusts: me1.feuerwerkBusts || 0,
      x2Busts: me1.x2Busts || 0,
      feuerwerkPointsScored: me1.feuerwerkPointsScored || 0,
      x2PointsScored: me1.x2PointsScored || 0,
      totalScore: me1.score || 0,
      highestTurnScore: me1.highestTurnScore || 0,
      fastestWinTurns: didAliceWin1 ? (me1.totalTurns || 0) : null,
      fastestLossTurns: !didAliceWin1 ? (me1.totalTurns || 0) : null
    });

    // ==========================================
    // GAME 2
    // ==========================================
    store = useGameStore.getState();
    store.startGame();

    // Simulate 120 seconds passing
    vi.setSystemTime(Date.now() + 120000);

    // Turn 1: Alice gets Kniffel and succeeds!
    store = useGameStore.getState();
    store.currentCard = 'Kniffel';
    store.nextTurn(0, true);

    // Turn 2: Bob gets Plus/Minus and fails
    store = useGameStore.getState();
    store.currentCard = 'Plus_Minus';
    store.nextTurn(0, false);

    // Turn 3: Alice gets Kleeblatt and succeeds (Instant Win!)
    store = useGameStore.getState();
    store.currentCard = 'Kleeblatt';
    store.nextTurn(0, true);

    expect(useGameStore.getState().finished).toBe(true);

    const payload2 = useGameStore.getState().buildGlobalStatsPayload();
    await database.updateGlobalStats(payload2);

    const me2 = useGameStore.getState().players[0]; // Alice
    const didAliceWin2 = 1;
    await database.updateDeviceStats(mockDeviceId, {
      gamesPlayed: 1,
      wins: didAliceWin2,
      totalPlaytime: 120,
      pointsDeducted: me2.times1000PointsDeducted || 0,
      plusMinusCompleted: me2.timesPlusMinusCompleted || 0,
      plusMinusFailed: me2.timesPlusMinusFailed || 0,
      kniffelCompleted: me2.timesKniffelCompleted || 0,
      kniffelFailed: me2.timesKniffelFailed || 0,
      skipped: me2.timesSkipped || 0,
      feuerwerkReceived: me2.timesFeuerwerkReceived || 0,
      kleeblattFailed: me2.timesKleeblattFailed || 0,
      kleeblattCompleted: me2.timesKleeblattCompleted || 0,
      x2Received: me2.timesx2Received || 0,
      totalTurns: me2.totalTurns || 0,
      busts: me2.busts || 0,
      feuerwerkBusts: me2.feuerwerkBusts || 0,
      x2Busts: me2.x2Busts || 0,
      feuerwerkPointsScored: me2.feuerwerkPointsScored || 0,
      x2PointsScored: me2.x2PointsScored || 0,
      totalScore: me2.score || 0,
      highestTurnScore: me2.highestTurnScore || 0,
      fastestWinTurns: didAliceWin2 ? (me2.totalTurns || 0) : null,
      fastestLossTurns: !didAliceWin2 ? (me2.totalTurns || 0) : null
    });

    // ==========================================
    // ASSERTIONS
    // ==========================================
    const globalStats = await database.getGlobalStats();
    const deviceStats = await database.getDeviceStats(mockDeviceId);

    expect(globalStats.totalGamesPlayed).toBeGreaterThanOrEqual(2);
    expect(globalStats.totalPlaytime).toBeGreaterThanOrEqual(170);
    
    expect(globalStats.totalFeuerwerk).toBeGreaterThanOrEqual(1);
    expect(globalStats.totalFeuerwerkPoints).toBeGreaterThanOrEqual(1000);
    expect(globalStats.totalFeuerwerkBusts).toBeGreaterThanOrEqual(1);

    expect(globalStats.totalx2).toBeGreaterThanOrEqual(1);
    expect(globalStats.totalx2Points).toBeGreaterThanOrEqual(2000);

    expect(globalStats.totalPlusMinus).toBeGreaterThanOrEqual(2);
    expect(globalStats.totalPlusMinusCompleted).toBeGreaterThanOrEqual(1);

    expect(globalStats.totalStop).toBeGreaterThanOrEqual(1);

    expect(globalStats.totalKniffel).toBeGreaterThanOrEqual(2);
    expect(globalStats.totalKniffelCompleted).toBeGreaterThanOrEqual(1);

    expect(globalStats.totalKleeblatt).toBeGreaterThanOrEqual(2);
    expect(globalStats.totalKleeblattCompleted).toBeGreaterThanOrEqual(1);

    expect(globalStats.highestTurnScore).toBeGreaterThanOrEqual(6000);
    expect(globalStats.fastestWinTurns).toBeLessThanOrEqual(4);
    expect(globalStats.fastestWinTurns).toBeGreaterThanOrEqual(1);

    expect(deviceStats.gamesPlayed).toBe(2);
    expect(deviceStats.wins).toBe(2);
    expect(deviceStats.totalPlaytime).toBe(170);
    expect(deviceStats.feuerwerkBusts).toBe(1);
    expect(deviceStats.plusMinusCompleted).toBe(1);
    expect(deviceStats.kniffelCompleted).toBe(1);
    expect(deviceStats.kleeblattCompleted).toBe(1);
    expect(deviceStats.highestTurnScore).toBe(6000);
    
    vi.useRealTimers();
  });
});
