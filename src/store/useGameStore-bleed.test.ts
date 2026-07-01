import { describe, it, expect, beforeEach } from 'vitest';
import { useGameStore, _resetTimersForTests } from './useGameStore';

describe('useGameStore configuration separation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useGameStore.getState().reset();
    _resetTimersForTests();
  });

  it('separates local and online configuration', () => {
    // Start local
    useGameStore.getState().setMode('local');
    // Change a setting
    useGameStore.getState().updateConfig({ winningScore: 7000 });
    expect(useGameStore.getState().winningScore).toBe(7000);

    // Switch to online
    useGameStore.getState().setMode('online');
    // Should be default because no online save exists
    expect(useGameStore.getState().winningScore).toBe(6000);

    // Change online setting
    useGameStore.getState().updateConfig({ winningScore: 9000 });
    expect(useGameStore.getState().winningScore).toBe(9000);

    // Switch to local
    useGameStore.getState().setMode('local');
    // Should restore local save
    expect(useGameStore.getState().winningScore).toBe(7000);
  });
});
