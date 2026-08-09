/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseSavedDiceState, buildDiceSnapshot, buildTurnKey, DICE_TURN_STATE_KEY } from './diceTurnState';

describe('the cached-turn storage key', () => {
  // Deliberately the raw string and not the constant: this is the one place
  // that pins what the key actually IS, so renaming the constant's value —
  // which would orphan every turn cached by an already-installed client —
  // cannot pass silently.
  it('is the key already-installed clients have on disk', () => {
    expect(DICE_TURN_STATE_KEY).toBe('tutto_dice_turn_state');
  });

  it('is never written out as a bare string anywhere else', () => {
    // Nineteen call sites read, write and clear this entry. A typo in one of
    // them fails quietly — the write lands on a key nobody reads, or the clear
    // leaves the real entry behind to be restored into somebody's next turn —
    // so no production file may spell it out for itself.
    const srcDir = path.resolve(__dirname, '..');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          if (full === __filename.replace('.test', '')) continue;
          if (fs.readFileSync(full, 'utf8').includes(`'${DICE_TURN_STATE_KEY}'`)) {
            offenders.push(path.relative(srcDir, full).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(srcDir);

    expect(offenders).toEqual([]);
  });
});

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
      expect(buildTurnKey(null, 1, 0, '200')).toBe('local:1:0:200:modernized');
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

    it('drops malformed entries/fields back to their defaults instead of propagating them', () => {
      // A corrupted tutto_dice_turn_state (hand-edited or from an older,
      // incompatible build) must not restore garbage into DiceGame's state —
      // e.g. currentRoll.filter/keptDice.map would throw if these weren't
      // arrays, crashing the render on mount.
      const raw = JSON.stringify({
        turnScore: 'not-a-number',
        keptDice: [{}],
        currentRoll: [{ id: 'r1', val: 5 }], // missing the required `selected`
        kniffelProgress: [7, 'x', 0],
        tuttosThisTurn: -1,
      });
      expect(parseSavedDiceState(raw)).toEqual({
        turnScore: 0,
        keptDice: [],
        currentRoll: [],
        kniffelProgress: [],
        tuttosThisTurn: 0,
        busted: false,
      });
    });

    it('resets keptDice/currentRoll to [] when the stored value is not an array at all', () => {
      const raw = JSON.stringify({ keptDice: 'nope', currentRoll: 42 });
      const parsed = parseSavedDiceState(raw)!;
      expect(parsed.keptDice).toEqual([]);
      expect(parsed.currentRoll).toEqual([]);
    });

    it('keeps a well-formed keptDice/currentRoll/kniffelProgress unchanged', () => {
      const raw = JSON.stringify({
        turnScore: 300,
        keptDice: [{ id: 'k1', val: 6 }],
        currentRoll: [{ id: 'r1', val: 1, selected: true }, { id: 'r2', val: 3, selected: false }],
        kniffelProgress: [1, 2, 3],
        tuttosThisTurn: 1,
      });
      expect(parseSavedDiceState(raw)).toEqual({
        turnScore: 300,
        keptDice: [{ id: 'k1', val: 6 }],
        currentRoll: [{ id: 'r1', val: 1, selected: true }, { id: 'r2', val: 3, selected: false }],
        kniffelProgress: [1, 2, 3],
        tuttosThisTurn: 1,
        busted: false,
      });
    });

    it('drops a non-string playerName instead of propagating a corrupted value', () => {
      expect(parseSavedDiceState(JSON.stringify({ playerName: 12345 }))!.playerName).toBeUndefined();
      expect(parseSavedDiceState(JSON.stringify({ playerName: 'Alice' }))!.playerName).toBe('Alice');
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
