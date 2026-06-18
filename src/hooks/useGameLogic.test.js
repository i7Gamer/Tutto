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

  it('should increment timesKleeblattCompleted and send it via fetch when succeeding on Kleeblatt', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.setInitialCards({ "Kleeblatt": 1 });
    });

    act(() => {
      result.current.startGame();
    });

    expect(result.current.currentCard).toBe('Kleeblatt');
    expect(result.current.currentPlayer.name).toBe('Alice');

    // Succeed on Kleeblatt
    act(() => {
      result.current.nextTurn(0, true);
    });

    expect(result.current.finished).toBe(true);
    
    const updatedPlayer = result.current.players.find(p => p.name === 'Alice');
    expect(updatedPlayer.timesKleeblattCompleted).toBe(1);
    expect(updatedPlayer.score).toBe(999999);

    expect(global.fetch).toHaveBeenCalledWith('/api/stats/global', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"totalKleeblattCompleted":1')
    }));
  });

  it('handles Plus_Minus card correctly by deducting 1000 from leaders', () => {
    // Make shuffleArray deterministic so array keeps its insertion order
    const originalRandom = Math.random;
    Math.random = () => 0.999999;

    const { result } = renderHook(() => useGameLogic());
    
    act(() => {
      result.current.addPlayer('Alice');
      result.current.addPlayer('Bob');
      result.current.setRandomOrder(false);
      // Give plenty of non-special cards, then a Plus_Minus
      result.current.setInitialCards({ "200": 2, "Plus_Minus": 1 });
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
    expect(result.current.currentPlayer.name).toBe('Alice');
    
    act(() => {
      result.current.nextTurn(0, true); // Alice succeeds
    });

    // Alice gets 1000 points, Bob (leader) loses 1000 points
    const alice = result.current.players.find(p => p.name === 'Alice');
    const bob = result.current.players.find(p => p.name === 'Bob');
    
    expect(alice.score).toBe(1000);
    expect(bob.score).toBe(1000); // Bob had 2000, lost 1000
    expect(bob.times1000PointsDeducted).toBe(1);
    expect(alice.timesPlusMinusCompleted).toBe(1);

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
});
