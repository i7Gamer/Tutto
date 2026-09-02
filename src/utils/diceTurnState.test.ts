/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseSavedDiceState, buildDiceSnapshot, buildTurnKey, DICE_TURN_STATE_KEY, PHYSICAL_TURN_STATE_KEY } from './diceTurnState';
import { MAX_CHAIN_CARDS } from '../types';
import { nonNull } from '../testing/factories';

describe('the cached-turn storage keys', () => {
  // Deliberately the raw strings and not the constants: this is the one place
  // that pins what the keys actually ARE, so renaming a constant's value —
  // which would orphan every turn cached by an already-installed client —
  // cannot pass silently.
  it('are the keys already-installed clients have on disk', () => {
    expect(DICE_TURN_STATE_KEY).toBe('tutto_dice_turn_state');
    expect(PHYSICAL_TURN_STATE_KEY).toBe('tutto_physical_turn_state');
  });

  it('are never written out as bare strings anywhere else', () => {
    // Many call sites read, write and clear these entries. A typo in one of
    // them fails quietly — the write lands on a key nobody reads, or the clear
    // leaves the real entry behind to be restored into somebody's next turn —
    // so no production file may spell either out for itself.
    const srcDir = path.resolve(__dirname, '..');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
          if (full === __filename.replace('.test', '')) continue;
          const source = fs.readFileSync(full, 'utf8');
          if (source.includes(`'${DICE_TURN_STATE_KEY}'`) || source.includes(`'${PHYSICAL_TURN_STATE_KEY}'`)) {
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
      // parseSavedDiceState's real caller (localStorage.getItem) only ever
      // hands back string | null, never undefined — but the `!raw` guard
      // treats every falsy input alike, so this deliberately feeds it a
      // value outside the declared domain to prove that holds.
      expect(parseSavedDiceState(undefined as unknown as string | null)).toBeNull();
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
      expect(nonNull(parseSavedDiceState(JSON.stringify({ busted: 1 }))).busted).toBe(true);
      expect(nonNull(parseSavedDiceState(JSON.stringify({ busted: 0 }))).busted).toBe(false);
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

    it('carries rollingDiceIds through, the only marker that the roll was still resolving', () => {
      // Dropped on restore, a snapshot cached mid-tumble is indistinguishable
      // from a settled one that nobody has selected from yet — and its
      // `busted` flag is written by finalizeRoll, which had not run when it
      // was cached. DiceGame needs this field to know the verdict is missing.
      const raw = JSON.stringify({
        turnScore: 0, keptDice: [], currentRoll: [{ id: 'r1', val: 2, selected: false }],
        kniffelProgress: [], tuttosThisTurn: 0, rollingDiceIds: ['r1', 'r2'],
      });
      expect(parseSavedDiceState(raw)!.rollingDiceIds).toEqual(['r1', 'r2']);
      expect(parseSavedDiceState(JSON.stringify({ turnScore: 0, rollingDiceIds: [] }))!.rollingDiceIds).toEqual([]);
    });

    it('leaves rollingDiceIds absent for a settled or legacy snapshot', () => {
      expect(parseSavedDiceState(JSON.stringify({ turnScore: 100 }))!.rollingDiceIds).toBeUndefined();
      expect(parseSavedDiceState(JSON.stringify({ turnScore: 0, busted: true }))!.rollingDiceIds).toBeUndefined();
    });

    it('drops a malformed rollingDiceIds back to absent instead of restoring it', () => {
      // Same all-or-nothing rule as the arrays above, and the same shape the
      // server enforces on a pushed snapshot's copy of this field: at most one
      // id per die on the table, each a plausible die id.
      const rolling = (v: unknown) =>
        parseSavedDiceState(JSON.stringify({ turnScore: 0, rollingDiceIds: v }))!.rollingDiceIds;

      expect(rolling('r1')).toBeUndefined();
      expect(rolling([123])).toBeUndefined();
      expect(rolling([''])).toBeUndefined();
      expect(rolling(['x'.repeat(65)])).toBeUndefined();
      expect(rolling(Array(7).fill('r1'))).toBeUndefined();
      expect(rolling(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    });

    describe('the classic-chain fields', () => {
      // Absent for every modernized turn and for any cache written before
      // chains existed, so "missing" has to stay a valid state -- but a
      // present-but-corrupt value is restored straight into the engine, which
      // reads cardsThisTurn as the turn's card list and chainTuttoCount as its
      // tutto tally. All-or-nothing per field, matching the arrays above.
      const chained = (overrides: Record<string, unknown>) =>
        parseSavedDiceState(JSON.stringify({ turnScore: 0, ...overrides }));

      it('keeps a valid chain', () => {
        const snapshot = chained({
          cardsThisTurn: ['200', 'x2', 'Feuerwerk'],
          plusMinusScores: [500, 0, 1200],
          chainTuttoCount: 2,
        });
        expect(snapshot?.cardsThisTurn).toEqual(['200', 'x2', 'Feuerwerk']);
        expect(snapshot?.plusMinusScores).toEqual([500, 0, 1200]);
        expect(snapshot?.chainTuttoCount).toBe(2);
      });

      it('leaves all three absent when the cache predates chains', () => {
        const snapshot = chained({});
        expect(snapshot).not.toBeNull();
        expect(snapshot?.cardsThisTurn).toBeUndefined();
        expect(snapshot?.plusMinusScores).toBeUndefined();
        expect(snapshot?.chainTuttoCount).toBeUndefined();
      });

      it.each([
        ['not an array', 'x2'],
        ['an unknown card', ['200', 'Joker']],
        ['a non-string entry', ['200', 7]],
        ['longer than a chain can be', Array(MAX_CHAIN_CARDS + 1).fill('200')],
      ])('drops cardsThisTurn when it is %s', (_label, cardsThisTurn) => {
        expect(chained({ cardsThisTurn })?.cardsThisTurn).toBeUndefined();
      });

      it('accepts a chain exactly at the cap', () => {
        // The bound itself, so the cap cannot quietly become off-by-one.
        expect(chained({ cardsThisTurn: Array(MAX_CHAIN_CARDS).fill('200') })?.cardsThisTurn)
          .toHaveLength(MAX_CHAIN_CARDS);
      });

      it.each([
        ['not an array', 500],
        ['negative', [500, -1]],
        ['non-finite', [500, Infinity]],
        ['not a number', [500, '600']],
        ['longer than a chain can be', Array(MAX_CHAIN_CARDS + 1).fill(0)],
      ])('drops plusMinusScores when it is %s', (_label, plusMinusScores) => {
        expect(chained({ plusMinusScores })?.plusMinusScores).toBeUndefined();
      });

      it.each([
        ['fractional', 1.5],
        ['negative', -1],
        ['above the chain cap', MAX_CHAIN_CARDS + 1],
        ['a string', '2'],
        ['a boolean', true],
      ])('drops chainTuttoCount when it is %s', (_label, chainTuttoCount) => {
        expect(chained({ chainTuttoCount })?.chainTuttoCount).toBeUndefined();
      });

      it('accepts a zero tutto count as a real value, not as missing', () => {
        // A chain that never scored a tutto is the common case, and `0` is
        // the falsy trap every one of these guards has to survive.
        expect(chained({ chainTuttoCount: 0 })?.chainTuttoCount).toBe(0);
      });
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
