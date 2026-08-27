import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import database from './database';
import { useGameStore } from '../src/store/useGameStore';
import { buildDeviceStatsPayload } from '../src/utils/coreGameEngine';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';

// Force the test DB
process.env.TEST_DB = 'true';

describe('End-to-End Statistics Integration', () => {
  beforeAll(async () => {
    await database.initDb();
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await database.knex.destroy();
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

    // Captured before Game 2's startGame() resets round/players — this is the
    // real per-game round count and player count sendOnlineStats would have sent.
    const round1 = useGameStore.getState().round;
    const playerCount1 = useGameStore.getState().players.length;

    const payload1 = useGameStore.getState().buildGlobalStatsPayload();
    await database.updateGlobalStats(payload1);

    // The payload the app actually builds, not a copy of it. The copy that
    // used to stand here had drifted: no totalTuttos, neither classic record,
    // and the superseded fastestLossTurns rule -- the one without the
    // `totalTurns > 0` guard, which records a 0-turn "fastest loss" for a seat
    // the game ended before and MIN-merges it into a record with no way back.
    // An integration test that hand-copies the thing it is integrating stops
    // being one the first time the original changes.
    const payloadFor = (playtime: number) => {
      const { players, myName, round } = useGameStore.getState();
      const stats = buildDeviceStatsPayload(players, myName ?? players[0].name, playtime, round);
      expect(stats, 'no seat for this device, so nothing would be recorded').not.toBeNull();
      return stats!;
    };

    await database.updateDeviceStats(mockDeviceId, payloadFor(50));

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

    const round2 = useGameStore.getState().round;
    const playerCount2 = useGameStore.getState().players.length;

    const payload2 = useGameStore.getState().buildGlobalStatsPayload();
    await database.updateGlobalStats(payload2);

    await database.updateDeviceStats(mockDeviceId, payloadFor(120));

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

    // Global row is shared across the whole test suite, so only the additive
    // sums/maxima can be pinned exactly relative to their pre-this-test value;
    // use >= for those that other tests could also have nudged upward.
    expect(globalStats.totalPlayersSum).toBeGreaterThanOrEqual(playerCount1 + playerCount2);
    expect(globalStats.mostPlayersInGame).toBeGreaterThanOrEqual(2);
    expect(globalStats.totalRoundsSum).toBeGreaterThanOrEqual(round1 + round2);
    expect(globalStats.longestGameRounds).toBeGreaterThanOrEqual(Math.max(round1, round2));
    // Alice's Feuerwerk turn (game 1, turn 1) scored 1000; Bob's x2 turn (game 1, turn 2) scored 2000.
    expect(globalStats.highestFeuerwerkTurnScore).toBeGreaterThanOrEqual(1000);
    expect(globalStats.highestX2TurnScore).toBeGreaterThanOrEqual(2000);

    // deviceStats is scoped to this test's unique mockDeviceId (Alice only),
    // so these can be asserted exactly.
    expect(deviceStats.totalPlayersSum).toBe(playerCount1 + playerCount2);
    expect(deviceStats.mostPlayersInGame).toBe(Math.max(playerCount1, playerCount2));
    expect(deviceStats.totalRoundsSum).toBe(round1 + round2);
    expect(deviceStats.longestGameRounds).toBe(Math.max(round1, round2));
    // Alice herself only ever drew Feuerwerk (game 1, scored 1000) — Bob drew
    // the x2 card, so Alice's own highestX2TurnScore stays 0.
    expect(deviceStats.highestFeuerwerkTurnScore).toBe(1000);
    expect(deviceStats.highestX2TurnScore).toBe(0);

    vi.useRealTimers();
  });
});
