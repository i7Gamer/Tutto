import { renderHook, act } from '@testing-library/react';
import { useGameLogic } from './useGameLogic';
import { beforeEach, describe, it, expect } from 'vitest';

describe('useGameLogic', () => {
  beforeEach(() => {
    localStorage.clear();
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
});
