import { describe, it, expect } from 'vitest';
import { pickLocalGameState } from './persistence';

describe('pickLocalGameState', () => {
  it('returns an empty object for non-object or null input', () => {
    expect(pickLocalGameState(null)).toEqual({});
    expect(pickLocalGameState('corrupt')).toEqual({});
    expect(pickLocalGameState(42)).toEqual({});
  });

  it('keeps only known local-game-state fields', () => {
    const parsed = {
      players: [{ name: 'Alice', score: 100 }],
      round: 3,
      winningScore: 7000,
      diceMode: 'digital',
      gameTimeInSeconds: 42,
    };
    expect(pickLocalGameState(parsed)).toEqual(parsed);
  });

  it('drops fields outside the known whitelist, including action names', () => {
    // A corrupted or hand-edited save must not be able to clobber a store
    // action (e.g. `startGame`) by Object.assign'ing an arbitrary key into it.
    const parsed = {
      round: 3,
      startGame: 'not a function anymore',
      __proto__: { polluted: true },
      randomJunkKey: 123,
    };
    const picked = pickLocalGameState(parsed);
    expect(picked).toEqual({ round: 3 });
    expect('startGame' in picked).toBe(false);
    expect('randomJunkKey' in picked).toBe(false);
  });

  it('omits absent fields rather than filling them with undefined', () => {
    const picked = pickLocalGameState({ round: 5 });
    expect(picked).toEqual({ round: 5 });
    expect(Object.keys(picked)).toEqual(['round']);
  });
});
