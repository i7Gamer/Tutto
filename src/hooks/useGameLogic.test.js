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
    });

    act(() => {
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

    // Check if randomOrder was automatically disabled
    expect(result.current.randomOrder).toBe(false);
    expect(result.current.players[0].name).toBe('Bob');
    expect(result.current.players[1].name).toBe('Alice');
    
    // Check if game starts with exact same order since randomOrder is false
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
      // Set initial deck to ONLY have a Kleeblatt card so it's guaranteed to be drawn
      result.current.setInitialCards({ "Kleeblatt": 1 });
    });

    act(() => {
      result.current.startGame();
    });

    expect(result.current.currentCard).toBe('Kleeblatt');
    expect(result.current.currentPlayer.name).toBe('Alice');
    expect(result.current.currentPlayer.timesKleeblattCompleted).toBe(0);

    // Succeed on Kleeblatt
    act(() => {
      result.current.nextTurn(0, true);
    });

    // Check that game is finished
    expect(result.current.finished).toBe(true);
    
    // Check if stats were incremented and score set to win
    const updatedPlayer = result.current.players.find(p => p.name === 'Alice');
    expect(updatedPlayer.timesKleeblattCompleted).toBe(1);
    expect(updatedPlayer.score).toBe(999999);

    // Verify fetch was called correctly with the new global stats
    expect(global.fetch).toHaveBeenCalledWith('/api/stats/global', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"totalKleeblattCompleted":1')
    }));
  });
});
