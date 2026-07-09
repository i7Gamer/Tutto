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

  it('passes a whitelisted field\'s value through unvalidated, even when its type is corrupted (STORE-TEST-3 / STORE-SEC-2)', () => {
    // pickLocalGameState whitelists KEYS only — it copies whatever value a
    // whitelisted key holds without checking its shape/type. A hand-edited or
    // corrupted localStorage save can therefore put a string where the store
    // expects a number/array, which surfaces as a crash further downstream
    // wherever that field is used (e.g. players.map, round arithmetic). This
    // test pins today's pass-through behavior so a future fix (adding value
    // validation) changes it deliberately rather than by accident.
    const parsed = { round: 'five', players: 'not-an-array', winningScore: null };
    const picked = pickLocalGameState(parsed);
    expect(picked.round).toBe('five');
    expect(picked.players).toBe('not-an-array');
    expect(picked.winningScore).toBeNull();
  });
});
