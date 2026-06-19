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

    // Start a new game — stats should reset
    act(() => {
      result.current.startGame();
    });

    alice = result.current.players.find(p => p.name === 'Alice');
    expect(alice.totalTurns).toBe(0);
    expect(alice.busts).toBe(0);
  });

  it('tracks Feuerwerk and x2 busts correctly', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Charlie');
    });

    act(() => {
      result.current.setInitialCards({ "Feuerwerk": 1, "x2": 1 });
    });

    act(() => {
      result.current.startGame();
    });

    // We start by drawing Feuerwerk
    expect(result.current.currentCard).toBe('Feuerwerk');
    
    act(() => {
      // Bust on Feuerwerk
      result.current.nextTurn(0, false);
    });

    let charlie = result.current.players.find(p => p.name === 'Charlie');
    expect(charlie.feuerwerkBusts).toBe(1);
    expect(charlie.x2Busts).toBe(0);
    expect(charlie.busts).toBe(1);

    // After nextTurn, it draws the next card which is x2
    expect(result.current.currentCard).toBe('x2');

    act(() => {
      // Bust on x2
      result.current.nextTurn(0, false);
    });

    charlie = result.current.players.find(p => p.name === 'Charlie');
    expect(charlie.feuerwerkBusts).toBe(1);
    expect(charlie.x2Busts).toBe(1);
    expect(charlie.busts).toBe(2);

    vi.spyOn(Math, 'random').mockRestore();
  });

  it('correctly tracks default game settings', () => {
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
});
