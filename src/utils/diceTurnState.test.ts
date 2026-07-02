import { describe, it, expect } from 'vitest';
import { parseSavedDiceState, buildDiceSnapshot, buildTurnKey } from './diceTurnState';

describe('diceTurnState', () => {
  describe('buildTurnKey', () => {
    it('differs when round changes for the same player and card', () => {
      const a = buildTurnKey('ROOM1', 1, 0, '200');
      const b = buildTurnKey('ROOM1', 2, 0, '200');
      expect(a).not.toBe(b);
    });

    it('differs when currentPlayerIndex changes', () => {
      const a = buildTurnKey('ROOM1', 1, 0, '200');
      const b = buildTurnKey('ROOM1', 1, 1, '200');
      expect(a).not.toBe(b);
    });

    it('differs when the card changes', () => {
      const a = buildTurnKey('ROOM1', 1, 0, '200');
      const b = buildTurnKey('ROOM1', 1, 0, '300');
      expect(a).not.toBe(b);
    });

    it('differs between rooms with otherwise identical turn state', () => {
      const a = buildTurnKey('ROOM1', 1, 0, '200');
      const b = buildTurnKey('ROOM2', 1, 0, '200');
      expect(a).not.toBe(b);
    });

    it('treats a null roomId as the local-game slot', () => {
      expect(buildTurnKey(null, 1, 0, '200')).toBe('local:1:0:200');
    });

    it('is identical for identical inputs (stable/deterministic)', () => {
      expect(buildTurnKey('ROOM1', 3, 1, 'Kniffel')).toBe(buildTurnKey('ROOM1', 3, 1, 'Kniffel'));
    });
  });

  describe('parseSavedDiceState', () => {
    it('returns null for empty/missing input', () => {
      expect(parseSavedDiceState(null)).toBeNull();
      expect(parseSavedDiceState(undefined)).toBeNull();
      expect(parseSavedDiceState('')).toBeNull();
    });

    it('returns null for corrupted JSON', () => {
      expect(parseSavedDiceState('not json {]')).toBeNull();
    });

    it('parses a full snapshot', () => {
      const raw = JSON.stringify({
        turnScore: 1250,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'b', val: 5, selected: true }],
        kniffelProgress: [1, 2],
        tuttosThisTurn: 1,
        busted: true,
        playerName: 'Alice',
      });
      expect(parseSavedDiceState(raw)).toEqual({
        turnScore: 1250,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'b', val: 5, selected: true }],
        kniffelProgress: [1, 2],
        tuttosThisTurn: 1,
        busted: true,
        playerName: 'Alice',
      });
    });

    it('applies defaults for missing fields', () => {
      expect(parseSavedDiceState('{}')).toEqual({
        turnScore: 0,
        keptDice: [],
        currentRoll: [],
        kniffelProgress: [],
        tuttosThisTurn: 0,
        busted: false,
      });
    });

    it('coerces busted to a boolean', () => {
      expect(parseSavedDiceState(JSON.stringify({ busted: 1 })).busted).toBe(true);
      expect(parseSavedDiceState(JSON.stringify({ busted: 0 })).busted).toBe(false);
    });

    it('returns undefined playerName for legacy snapshots that do not contain the field', () => {
      const raw = JSON.stringify({ turnScore: 500, keptDice: [], currentRoll: [], kniffelProgress: [], tuttosThisTurn: 0 });
      expect(parseSavedDiceState(raw)!.playerName).toBeUndefined();
    });

    it('passes through turnKey when present, and leaves it undefined for legacy snapshots', () => {
      const withKey = JSON.stringify({ turnScore: 100, turnKey: 'ROOM1:2:0:200' });
      expect(parseSavedDiceState(withKey)!.turnKey).toBe('ROOM1:2:0:200');

      const legacy = JSON.stringify({ turnScore: 100 });
      expect(parseSavedDiceState(legacy)!.turnKey).toBeUndefined();
    });
  });

  describe('buildDiceSnapshot', () => {
    const kept = [{ id: 'k1', val: 1, extra: 'drop' }];
    const roll = [
      { id: 'r1', val: 5, selected: true, extra: 'drop' },
      { id: 'r2', val: 3, selected: false },
    ];

    it('builds an active snapshot with rollingDiceIds and preserved selection', () => {
      const snap = buildDiceSnapshot({
        turnScore: 300,
        keptDice: kept,
        currentRoll: roll,
        kniffelProgress: [1],
        tuttosThisTurn: 0,
        rollingDiceIndices: new Set(['r2']),
      });
      expect(snap).toEqual({
        turnScore: 300,
        keptDice: [{ id: 'k1', val: 1 }],
        currentRoll: [
          { id: 'r1', val: 5, selected: true },
          { id: 'r2', val: 3, selected: false },
        ],
        kniffelProgress: [1],
        tuttosThisTurn: 0,
        rollingDiceIds: ['r2'],
      });
      expect(snap).not.toHaveProperty('busted');
    });

    it('strips fields other than id/val/selected', () => {
      const snap = buildDiceSnapshot({
        turnScore: 0, keptDice: kept, currentRoll: roll,
        kniffelProgress: [], tuttosThisTurn: 0, rollingDiceIndices: new Set(),
      });
      expect(snap.keptDice[0]).not.toHaveProperty('extra');
      expect(snap.currentRoll[0]).not.toHaveProperty('extra');
    });

    it('defaults rollingDiceIds to an empty array when omitted', () => {
      const snap = buildDiceSnapshot({
        turnScore: 0, keptDice: [], currentRoll: [],
        kniffelProgress: [], tuttosThisTurn: 0,
      });
      expect(snap.rollingDiceIds).toEqual([]);
    });

    it('builds a busted snapshot: dice deselected, busted flag set, no rollingDiceIds', () => {
      const snap = buildDiceSnapshot({
        turnScore: 0,
        keptDice: kept,
        currentRoll: roll,
        kniffelProgress: [],
        tuttosThisTurn: 0,
        busted: true,
      });
      expect(snap.busted).toBe(true);
      expect(snap).not.toHaveProperty('rollingDiceIds');
      expect(snap.currentRoll.every(d => d.selected === false)).toBe(true);
    });
  });
});
