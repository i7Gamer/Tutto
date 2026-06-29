import { describe, it, expect } from 'vitest';
import { parseSavedDiceState, buildDiceSnapshot } from './diceTurnState';

describe('diceTurnState', () => {
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
      });
      expect(parseSavedDiceState(raw)).toEqual({
        turnScore: 1250,
        keptDice: [{ id: 'a', val: 1 }],
        currentRoll: [{ id: 'b', val: 5, selected: true }],
        kniffelProgress: [1, 2],
        tuttosThisTurn: 1,
        busted: true,
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
