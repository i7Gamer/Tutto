import { renderHook, act } from '@testing-library/react';
import { useGameLogic } from './useGameLogic';
import { beforeEach, describe, it, expect, vi, afterEach } from 'vitest';

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem(key) { return store[key] || null; },
    setItem(key, value) { store[key] = value.toString(); },
    clear() { store = {}; },
    removeItem(key) { delete store[key]; }
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// Mock fetch for sendGlobalStats
global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

describe('useGameLogic', () => {
  beforeEach(() => {
    localStorageMock.clear();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds and removes players correctly', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
    });

    expect(result.current.players).toHaveLength(2);
    expect(result.current.players[0].name).toBe('Alice');

    act(() => {
      result.current.removePlayer('Alice');
    });

    expect(result.current.players).toHaveLength(1);
    expect(result.current.players[0].name).toBe('Bob');
  });

  it('starts a game and assigns a current card and player', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.startGame();
    });

    expect(result.current.currentPlayerIndex).toBe(0);
    expect(result.current.currentCard).not.toBeNull();
    expect(result.current.round).toBe(1);
  });

  it('nextTurn adds score correctly', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.setInitialCards({ "200": 10 });
    });

    act(() => {
      result.current.startGame();
    });

    const initialScore = result.current.players[0].score;

    act(() => {
      result.current.nextTurn(500, false);
    });

    expect(result.current.players[0].score).toBe(initialScore + 500);
  });

  it('should allow reordering players and disable randomOrder automatically', () => {
    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.addPlayer('Charlie');
    });

    expect(result.current.players.length).toBe(3);
    expect(result.current.randomOrder).toBe(true);

    // Reorder players (swap Bob and Alice)
    act(() => {
      result.current.reorderPlayers([
        result.current.players[1], // Bob
        result.current.players[0], // Alice
        result.current.players[2]  // Charlie
      ]);
    });

    expect(result.current.randomOrder).toBe(false);
    
    act(() => {
      result.current.startGame();
    });
    
    expect(result.current.players[0].name).toBe('Bob');
    expect(result.current.players[1].name).toBe('Alice');
  });

  it('handles Kleeblatt success and failure statistics', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.setInitialCards({ "Kleeblatt": 2 });
    });

    act(() => {
      result.current.startGame();
    });

    expect(result.current.currentCard).toBe('Kleeblatt');
    
    // Fail on first Kleeblatt
    act(() => {
      result.current.nextTurn(0, false);
    });
    
    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.timesKleeblattFailed).toBe(1);
    expect(alice.timesKleeblattCompleted).toBe(0);

    // Succeed on second Kleeblatt
    expect(result.current.currentCard).toBe('Kleeblatt');
    act(() => {
      result.current.nextTurn(0, true);
    });

    expect(result.current.finished).toBe(true);
    
    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.timesKleeblattFailed).toBe(1);
    expect(alice.timesKleeblattCompleted).toBe(1);
    expect(alice.score).toBe(999999);

    expect(global.fetch).toHaveBeenCalledWith('/api/stats/global', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"totalKleeblattCompleted":1')
    }));
  });

  it('handles Plus_Minus card success and failure statistics', () => {
    // Make shuffleArray deterministic so array keeps its insertion order
    const originalRandom = Math.random;
    Math.random = () => 0.999999;

    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ "200": 2, "Plus_Minus": 2 });
    });

    act(() => {
      result.current.startGame();
    });

    // Round 1: Alice turn (200 card)
    act(() => {
      result.current.nextTurn(0, false); // Alice gets 0 points
    });

    // Round 1: Bob turn (200 card)
    act(() => {
      result.current.nextTurn(2000, false); // Bob gets 2000 points, becomes leader
    });

    // Round 2: Alice turn (Plus_Minus card)
    expect(result.current.currentCard).toBe('Plus_Minus');
    act(() => {
      result.current.nextTurn(0, false); // Alice fails
    });

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.timesPlusMinusFailed).toBe(1);
    expect(alice.timesPlusMinusCompleted).toBe(0);

    // Round 2: Bob turn (Plus_Minus card)
    act(() => {
      result.current.nextTurn(0, true); // Bob succeeds
    });

    // Bob is leader, so nobody loses 1000, but Bob gets 1000 points and a completion stat
    let bob = result.current.players.find(p => p.name === 'Bob');
    expect(bob.timesPlusMinusCompleted).toBe(1);
    expect(bob.timesPlusMinusFailed).toBe(0);
    expect(bob.score).toBe(3000); // 2000 + 1000

    Math.random = originalRandom; // Restore Math.random
  });

  it('handles Kniffel card success and failure statistics', () => {
    const originalRandom = Math.random;
    Math.random = () => 0.999999;

    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ "Kniffel": 2 });
    });

    act(() => {
      result.current.startGame();
    });

    expect(result.current.currentCard).toBe('Kniffel');
    
    // Fail first Kniffel
    act(() => {
      result.current.nextTurn(0, false); 
    });

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.timesKniffelFailed).toBe(1);
    expect(alice.timesKniffelCompleted).toBe(0);
    expect(alice.score).toBe(0);

    // Succeed second Kniffel
    expect(result.current.currentCard).toBe('Kniffel');
    act(() => {
      result.current.nextTurn(0, true); 
    });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.timesKniffelFailed).toBe(1);
    expect(alice.timesKniffelCompleted).toBe(1);
    expect(alice.score).toBe(2000); // Kniffel success gives 2000 points

    Math.random = originalRandom; // Restore Math.random
  });

  it('handles undo logic correctly to restore scores and previous cards', () => {
    // Deterministic shuffle
    const originalRandom = Math.random;
    Math.random = () => 0.999999;

    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ "200": 5 });
    });

    act(() => {
      result.current.startGame();
    });

    // Round 1: Alice turn
    act(() => {
      result.current.nextTurn(500, false); 
    });

    // Round 1: Bob turn, Bob is about to play but clicks UNDO
    expect(result.current.currentPlayer.name).toBe('Bob');
    expect(result.current.players.find(p => p.name === 'Alice').score).toBe(500);

    act(() => {
      result.current.undo();
    });

    // It should revert back to Alice's turn before she submitted 500
    expect(result.current.currentPlayer.name).toBe('Alice');
    expect(result.current.players.find(p => p.name === 'Alice').score).toBe(0);

    Math.random = originalRandom;
  });

  it('handles Plus_Minus non-leader completion and undo', () => {
    // Deterministic shuffle
    const originalRandom = Math.random;
    Math.random = () => 0.999999;

    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice'); // Player 1
      result.current.addPlayer('Bob');   // Player 2
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ "200": 1, "Plus_Minus": 1 });
    });

    act(() => {
      result.current.startGame();
    });

    // Round 1: Alice turn (200 card)
    act(() => {
      result.current.nextTurn(2000, false); // Alice becomes leader with 2000
    });

    // Round 1: Bob turn (Plus_Minus card)
    act(() => {
      result.current.nextTurn(0, true); // Bob succeeds, Bob is NOT leader
    });

    // Alice should lose 1000 points
    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.score).toBe(1000); // 2000 - 1000
    expect(alice.times1000PointsDeducted).toBe(1);

    // Bob should gain 1000 points
    let bob = result.current.players.find(p => p.name === 'Bob');
    expect(bob.score).toBe(1000); // 0 + 1000

    // Now Round 2 starts. It's Alice's turn again.
    // Let's UNDO Bob's turn
    act(() => {
      result.current.undo();
    });

    // Alice should get her 1000 points back!
    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.score).toBe(2000);
    expect(alice.times1000PointsDeducted).toBe(0);

    // Bob should lose his 1000 points
    bob = result.current.players.find(p => p.name === 'Bob');
    expect(bob.score).toBe(0);

    Math.random = originalRandom;
  });

  it('ends the game when winning score is reached at the end of a round', () => {
    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      result.current.setWinningScore(6000);
      result.current.setInitialCards({ "200": 5 });
    });

    act(() => {
      result.current.startGame();
    });

    // Round 1: Alice turn
    act(() => {
      result.current.nextTurn(6500, false); // Alice hits winning score
    });

    // Game is NOT over yet because round must finish (Bob's turn next)
    expect(result.current.finished).toBe(false);
    expect(result.current.currentPlayer.name).toBe('Bob');

    // Round 1: Bob turn
    act(() => {
      result.current.nextTurn(0, false); 
    });

    // Now round ends. Alice has highest score >= 6000. Game over.
    expect(result.current.finished).toBe(true);
    expect(result.current.winner.name).toBe('Alice');
  });

  it('tracks totalTurns and busts correctly (bust = 0 points on non-Stop card)', () => {
    const originalRandom = Math.random;
    Math.random = () => 0.999999;

    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ "200": 2, "Stop": 1 });
    });

    act(() => {
      result.current.startGame();
    });

    // Turn 1: Alice scores 0 on a 200 card → should be a bust
    act(() => {
      result.current.nextTurn(0, false);
    });

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(1);
    expect(alice.busts).toBe(1);

    // Turn 2: Alice scores 500 → not a bust
    act(() => {
      result.current.nextTurn(500, false);
    });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(2);
    expect(alice.busts).toBe(1); // still 1

    // Turn 3: Alice gets a Stop card (0 points) → NOT a bust
    expect(result.current.currentCard).toBe('Stop');
    act(() => {
      result.current.nextTurn(0, false);
    });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(3);
    expect(alice.busts).toBe(1); // Stop cards don't count as busts

    Math.random = originalRandom;
  });

  it('resets totalTurns and busts when starting a new game', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ "200": 10 });
    });

    act(() => {
      result.current.startGame();
    });

    // Play a turn
    act(() => {
      result.current.nextTurn(0, false);
    });

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(1);
    expect(alice.busts).toBe(1);

    // Let's also add some x2 and Feuerwerk data before resetting
    alice.feuerwerkBusts = 3;
    alice.feuerwerkPointsScored = 1500;
    alice.x2Busts = 2;
    alice.x2PointsScored = 2000;

    // Start a new game — stats should reset
    act(() => {
      result.current.startGame();
    });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(0);
    expect(alice.busts).toBe(0);
    expect(alice.feuerwerkBusts).toBe(0);
    expect(alice.feuerwerkPointsScored).toBe(0);
    expect(alice.x2Busts).toBe(0);
    expect(alice.x2PointsScored).toBe(0);
  });

  it('tracks Feuerwerk and x2 busts and points correctly', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const { result } = renderHook(() => useGameLogic());
    
    // Scenario 1: Feuerwerk Bust
    act(() => {
      result.current.addPlayer('Charlie');
      result.current.setInitialCards({ "Feuerwerk": 1 });
    });
    act(() => {
      result.current.startGame();
    });

    expect(result.current.currentCard).toBe('Feuerwerk');
    
    act(() => {
      result.current.nextTurn(0, false); // Bust
    });

    let charlie = result.current.players.find(p => p.name === 'Charlie');
    expect(charlie.feuerwerkBusts).toBe(1);
    expect(charlie.feuerwerkPointsScored).toBe(0);

    // Scenario 2: x2 Bust
    act(() => {
      result.current.setInitialCards({ "x2": 1 });
    });
    act(() => {
      result.current.startGame(); // Resets everything!
    });

    expect(result.current.currentCard).toBe('x2');
    
    act(() => {
      result.current.nextTurn(0, false); // Bust
    });

    charlie = result.current.players.find(p => p.name === 'Charlie');
    expect(charlie.x2Busts).toBe(1);
    expect(charlie.x2PointsScored).toBe(0);
    expect(charlie.feuerwerkBusts).toBe(0); // Reset verified

    // Scenario 3: Feuerwerk Points
    act(() => {
      result.current.setInitialCards({ "Feuerwerk": 1 });
    });
    act(() => {
      result.current.startGame(); // Resets
    });

    expect(result.current.currentCard).toBe('Feuerwerk');
    
    act(() => {
      result.current.nextTurn(1500, false); 
    });

    charlie = result.current.players.find(p => p.name === 'Charlie');
    expect(charlie.feuerwerkPointsScored).toBe(1500);

    // Scenario 4: x2 Points
    act(() => {
      result.current.setInitialCards({ "x2": 1 });
    });
    act(() => {
      result.current.startGame(); // Resets
    });

    expect(result.current.currentCard).toBe('x2');
    
    act(() => {
      result.current.nextTurn(2000, false); 
    });

    charlie = result.current.players.find(p => p.name === 'Charlie');
    expect(charlie.x2PointsScored).toBe(2000);

    vi.spyOn(Math, 'random').mockRestore();
  });

  it('correctly tracks default game settings', () => {
    global.fetch.mockClear();
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // Ensure we don't draw Stop or Kleeblatt
    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
    });

    act(() => {
      result.current.startGame();
    });

    act(() => {
      result.current.nextTurn(6000, true);
    });
    
    let fetchCall = global.fetch.mock.calls.find(call => call[0] === '/api/stats/global');
    expect(fetchCall).toBeDefined();
    let payload = JSON.parse(fetchCall[1].body);
    expect(payload.isDefaultGame).toBe(true);

    vi.spyOn(Math, 'random').mockRestore();
  });

  it('bounds Plus_Minus deductions at zero and restores them correctly on undo', () => {
    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setInitialCards({ '200': 1, 'Plus_Minus': 10 }); // First card 200, then Plus_Minus
    });

    act(() => {
      result.current.startGame();
    });

    // Alice gets 500 points
    act(() => {
      result.current.nextTurn(500, false); 
    });

    expect(result.current.players[0].score).toBe(500); // Alice has 500

    // Bob plays Plus_Minus and succeeds!
    act(() => {
      result.current.nextTurn(0, true); 
    });

    expect(result.current.players[1].score).toBe(1000); // Bob got 1000
    // Alice's score should drop to 0 (bounded), NOT -500!
    expect(result.current.players[0].score).toBe(0);

    // Bob undos his turn
    act(() => {
      result.current.undo();
    });

    expect(result.current.players[1].score).toBe(0); // Bob loses his 1000
    // Alice's score should be restored to exactly 500!
    expect(result.current.players[0].score).toBe(500);
  });

  it('correctly tracks custom game settings', () => {
    global.fetch.mockClear();
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Bob');
      result.current.setInitialCards({ Kleeblatt: 99 });
    });

    act(() => {
      result.current.startGame();
    });

    act(() => {
      result.current.nextTurn(6000, true);
    });
    
    let fetchCall = global.fetch.mock.calls.find(call => call[0] === '/api/stats/global');
    expect(fetchCall).toBeDefined();
    let payload = JSON.parse(fetchCall[1].body);
    expect(payload.isDefaultGame).toBe(false);
  });

  // ─── Bug 1 & 2: undo must reverse ALL stat counters ────────────────────────

  it('[Bug 1] undo reverses totalTurns and busts', () => {
    const originalRandom = Math.random;
    Math.random = () => 0.999999;
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ '200': 2 });
    });
    act(() => { result.current.startGame(); });

    // Alice busts on '200' card (score 0)
    act(() => { result.current.nextTurn(0, false); });

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(1);
    expect(alice.busts).toBe(1);

    // Bob undoes Alice's turn
    act(() => { result.current.undo(); });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(0);
    expect(alice.busts).toBe(0);

    Math.random = originalRandom;
  });

  it('[Bug 1] undo reverses feuerwerkBusts, feuerwerkPointsScored', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ 'Feuerwerk': 2 });
    });
    act(() => { result.current.startGame(); });

    // Feuerwerk is the only card — guaranteed
    expect(result.current.currentCard).toBe('Feuerwerk');
    act(() => { result.current.nextTurn(0, false); }); // Alice busts

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.feuerwerkBusts).toBe(1);
    expect(alice.feuerwerkPointsScored).toBe(0);
    expect(alice.timesFeuerwerkReceived).toBe(1);
    expect(alice.totalTurns).toBe(1);
    expect(alice.busts).toBe(1);

    // Bob undoes Alice's turn
    act(() => { result.current.undo(); });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.feuerwerkBusts).toBe(0);
    expect(alice.feuerwerkPointsScored).toBe(0);
    expect(alice.timesFeuerwerkReceived).toBe(0);
    expect(alice.totalTurns).toBe(0);
    expect(alice.busts).toBe(0);
  });

  it('[Bug 1] undo reverses x2Busts and x2PointsScored', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ 'x2': 2 });
    });
    act(() => { result.current.startGame(); });

    // x2 is the only card — guaranteed
    expect(result.current.currentCard).toBe('x2');
    act(() => { result.current.nextTurn(500, false); }); // Alice scores 500 on x2

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.x2PointsScored).toBe(500);
    expect(alice.timesx2Received).toBe(1);
    expect(alice.totalTurns).toBe(1);

    // Bob undoes Alice's turn
    act(() => { result.current.undo(); });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.x2PointsScored).toBe(0);
    expect(alice.timesx2Received).toBe(0);
    expect(alice.totalTurns).toBe(0);
  });

  it('[Bug 2] undo checks previousCard for Feuerwerk, not currentCard', () => {
    // Scenario: 2-player game. Alice plays a '200' card. After her turn,
    // the next card drawn is Feuerwerk (shown to Bob). Bob clicks undo.
    // Bug 2: the old code checks `currentCard === 'Feuerwerk'` and wrongly
    // decrements Alice's timesFeuerwerkReceived even though Alice played '200'.
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      // Single card type guarantees Alice gets '200', then Feuerwerk is drawn next
      result.current.setInitialCards({ '200': 1, 'Feuerwerk': 1 });
    });
    act(() => { result.current.startGame(); });

    // Whichever card is first, we record it
    const aliceCard = result.current.currentCard;
    act(() => { result.current.nextTurn(300, false); }); // Alice plays

    // Capture Alice's timesFeuerwerkReceived immediately after her turn
    let alice = result.current.players.find(p => p.name === 'Alice');
    const feuerwerkAfterAlice = alice.timesFeuerwerkReceived;
    // Should be 1 only if Alice drew Feuerwerk, 0 otherwise
    expect(feuerwerkAfterAlice).toBe(aliceCard === 'Feuerwerk' ? 1 : 0);

    // Now Bob sees the next card (could be Feuerwerk). Bob clicks undo.
    act(() => { result.current.undo(); });

    alice = result.current.players.find(p => p.name === 'Alice');
    // After undo, timesFeuerwerkReceived must equal what it was BEFORE Alice's turn (0)
    expect(alice.timesFeuerwerkReceived).toBe(0);
  });

  // ─── Bug 6: Kleeblatt win sets currentPlayerIndex to null ──────────────────

  it('[Bug 6] Kleeblatt win sets currentPlayerIndex to null', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.setInitialCards({ 'Kleeblatt': 1 });
    });
    act(() => { result.current.startGame(); });

    expect(result.current.currentCard).toBe('Kleeblatt');
    act(() => { result.current.nextTurn(0, true); }); // Kleeblatt success

    expect(result.current.finished).toBe(true);
    expect(result.current.currentPlayerIndex).toBeNull();
    expect(result.current.currentPlayer).toBeNull();
  });

  // ─── Bug 8: Yes/No cards (Plus_Minus, Kniffel, Kleeblatt) should not count as busts ──────────────────

  it('[Bug 8] Failing a Yes/No card does not increment busts', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ 'Plus_Minus': 1, 'Kniffel': 1, 'Kleeblatt': 1 });
    });
    act(() => { result.current.startGame(); });

    // Assuming deterministic deck means we draw Kleeblatt first if added last, or Plus_Minus if reversed.
    // We just check whichever card is drawn.
    const firstCard = result.current.currentCard;
    act(() => { result.current.nextTurn(0, false); }); // Fail the card

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(1);
    expect(alice.busts).toBe(0); // Should be 0, not 1!

    // Draw the next card
    const secondCard = result.current.currentCard;
    act(() => { result.current.nextTurn(0, false); }); // Fail the card

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(2);
    expect(alice.busts).toBe(0);

    const thirdCard = result.current.currentCard;
    act(() => { result.current.nextTurn(0, false); }); // Fail the card

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(3);
    expect(alice.busts).toBe(0);

    // Verify all 3 Yes/No cards were played
    const playedCards = [firstCard, secondCard, thirdCard].sort();
    expect(playedCards).toEqual(['Kleeblatt', 'Kniffel', 'Plus_Minus'].sort());
  });

  it('[Bug 8] Undoing a failed Yes/No card does not decrement busts incorrectly', () => {
    const { result } = renderHook(() => useGameLogic());

    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      result.current.setInitialCards({ 'Kniffel': 2 });
    });
    act(() => { result.current.startGame(); });

    // Alice draws Kniffel and fails it
    expect(result.current.currentCard).toBe('Kniffel');
    act(() => { result.current.nextTurn(0, false); });

    let alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(1);
    expect(alice.busts).toBe(0);

    // Undo Alice's turn
    act(() => { result.current.undo(); });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(0);
    expect(alice.busts).toBe(0); // Should not become -1
  });
});

