import { describe, it, expect } from 'vitest';
import { diceTurnReducer, initialDiceTurnState, type DiceTurnState } from './diceTurnReducer';
import type { RestoredTurn } from './diceTurnRestore';
import type { Die, DiceSnapshot } from '../types';

const die = (id: string, val: number, selected = false): Die => ({ id, val, selected });

// A playable mid-turn baseline: two kept dice, four on the table, some score.
const baseState = (): DiceTurnState => ({
  keptDice: [die('k1', 5), die('k2', 1)],
  currentRoll: [die('a', 2), die('b', 5, true), die('c', 3), die('d', 1, true)],
  turnScore: 150,
  kniffelProgress: [],
  hasRolled: true,
  bustState: false,
  stopped: false,
  showSummary: false,
  summaryData: { won: false, score: 0, isTutto: false },
  tuttosThisTurn: 0,
  chainCardCount: 1,
});

// A fresh RestoredTurn as deriveRestoredTurn produces for a turn with nothing
// cached — the shape DiceGame mounts a brand-new turn from.
const freshRestore = (): RestoredTurn => ({
  midDraw: false,
  currentRoll: [],
  summary: null,
  busted: false,
  bankedDecision: false,
  hasRolled: false,
  initialChain: { cards: [{ card: '300', completed: false }], tuttoCount: 0, plusMinusScores: [], ended: 'null' },
});

describe('initialDiceTurnState', () => {
  it('starts a fresh turn empty, with the chain seed counted', () => {
    const s = initialDiceTurnState({ restored: null, restore: freshRestore() });

    expect(s).toEqual({
      keptDice: [], currentRoll: [], turnScore: 0, kniffelProgress: [],
      hasRolled: false, bustState: false, stopped: false, showSummary: false,
      summaryData: { won: false, score: 0, isTutto: false },
      tuttosThisTurn: 0, chainCardCount: 1,
    });
  });

  it('resumes a playable table from the snapshot, dice re-derived by the restore module', () => {
    const restored = {
      turnScore: 350, keptDice: [die('k', 5)], kniffelProgress: [2],
      tuttosThisTurn: 1, currentRoll: [die('x', 4)],
    } as unknown as DiceSnapshot;
    const restore: RestoredTurn = {
      ...freshRestore(),
      // The restore module may rewrite the roll (forced Feuerwerk keep) — the
      // machine must take ITS dice, not the raw snapshot's.
      currentRoll: [die('x', 4, true)],
      hasRolled: true,
    };

    const s = initialDiceTurnState({ restored, restore });

    expect(s.turnScore).toBe(350);
    expect(s.keptDice).toEqual([die('k', 5)]);
    expect(s.kniffelProgress).toEqual([2]);
    expect(s.tuttosThisTurn).toBe(1);
    expect(s.currentRoll).toEqual([die('x', 4, true)]);
    expect(s.hasRolled).toBe(true);
    expect(s.showSummary).toBe(false);
  });

  it('opens straight on the summary for a decided restore, stopped marker included', () => {
    const restore: RestoredTurn = {
      ...freshRestore(),
      summary: { won: true, score: 800, isTutto: true },
      bankedDecision: true,
      hasRolled: true,
    };

    const s = initialDiceTurnState({ restored: { turnScore: 800 } as unknown as DiceSnapshot, restore });

    expect(s.showSummary).toBe(true);
    expect(s.summaryData).toEqual({ won: true, score: 800, isTutto: true });
    expect(s.stopped).toBe(true);
  });

  it('seeds a bust restore with bustState', () => {
    const restore: RestoredTurn = { ...freshRestore(), busted: true, hasRolled: true };
    expect(initialDiceTurnState({ restored: {} as unknown as DiceSnapshot, restore }).bustState).toBe(true);
  });
});

describe('diceTurnReducer', () => {
  it('ROLL_STARTED puts the new dice down, clears a prior bust and marks the turn rolled', () => {
    const rolls = [die('n1', 6), die('n2', 2)];
    const s = diceTurnReducer(
      { ...baseState(), bustState: true, hasRolled: false },
      { type: 'ROLL_STARTED', rolls },
    );

    expect(s.currentRoll).toBe(rolls);
    expect(s.bustState).toBe(false);
    expect(s.hasRolled).toBe(true);
    // A roll changes nothing that was already banked or kept.
    expect(s.keptDice).toEqual(baseState().keptDice);
    expect(s.turnScore).toBe(150);
  });

  it('ROLL_BUSTED flags the bust and nothing else', () => {
    const before = baseState();
    const s = diceTurnReducer(before, { type: 'ROLL_BUSTED' });

    expect(s.bustState).toBe(true);
    expect(s.currentRoll).toBe(before.currentRoll);
    expect(s.showSummary).toBe(false);
  });

  it('FEUERWERK_SELECTION_FORCED selects every scoring die and locks nothing else in', () => {
    const s = diceTurnReducer(
      { ...baseState(), currentRoll: [die('a', 5), die('b', 2), die('c', 1), die('d', 3)] },
      { type: 'FEUERWERK_SELECTION_FORCED', ruleset: 'classic' },
    );

    expect(s.currentRoll.map(d => d.selected)).toEqual([true, false, true, false]);
  });

  it('DIE_TOGGLED flips exactly the matching die', () => {
    const s = diceTurnReducer(baseState(), { type: 'DIE_TOGGLED', id: 'a' });

    expect(s.currentRoll.find(d => d.id === 'a')!.selected).toBe(true);
    expect(s.currentRoll.find(d => d.id === 'b')!.selected).toBe(true);
    expect(s.currentRoll.find(d => d.id === 'c')!.selected).toBe(false);
  });

  it('DIE_TOGGLED with an unknown id changes no die', () => {
    const before = baseState();
    const s = diceTurnReducer(before, { type: 'DIE_TOGGLED', id: 'ghost' });

    expect(s.currentRoll).toEqual(before.currentRoll);
  });

  it('SELECTION_SET selects exactly the given indices, deselecting the rest', () => {
    const s = diceTurnReducer(baseState(), { type: 'SELECTION_SET', indices: new Set([0, 2]) });

    expect(s.currentRoll.map(d => d.selected)).toEqual([true, false, true, false]);
  });

  it('ROLL_ON_COMMITTED banks the selection into the running fields and leaves the table for roll()', () => {
    const kept = [die('k1', 5), die('k2', 1), die('b', 5)];
    const before = baseState();
    const s = diceTurnReducer(before, {
      type: 'ROLL_ON_COMMITTED', turnScore: 250, keptDice: kept, kniffelProgress: [4],
    });

    expect(s.turnScore).toBe(250);
    expect(s.keptDice).toBe(kept);
    expect(s.kniffelProgress).toEqual([4]);
    // roll() replaces the table itself; committing must not clear it early.
    expect(s.currentRoll).toBe(before.currentRoll);
  });

  it('KLEEBLATT_FIRST_TUTTO clears the tray and counts the first tutto', () => {
    const s = diceTurnReducer(baseState(), {
      type: 'KLEEBLATT_FIRST_TUTTO', turnScore: 400, kniffelProgress: [],
    });

    expect(s.tuttosThisTurn).toBe(1);
    expect(s.keptDice).toEqual([]);
    expect(s.turnScore).toBe(400);
  });

  it('TABLE_COMMITTED commits the decided table and empties the roll', () => {
    const kept = [die('k1', 5)];
    const s = diceTurnReducer(baseState(), {
      type: 'TABLE_COMMITTED', turnScore: 600, keptDice: kept, kniffelProgress: [6],
    });

    expect(s.turnScore).toBe(600);
    expect(s.keptDice).toBe(kept);
    expect(s.kniffelProgress).toEqual([6]);
    expect(s.currentRoll).toEqual([]);
    // Banking is its own decision — a committed table alone shows no summary.
    expect(s.showSummary).toBe(false);
    expect(s.stopped).toBe(false);
  });

  it('TURN_BANKED marks the decision and opens the summary without touching the committed fields', () => {
    const before = { ...baseState(), turnScore: 600, currentRoll: [] as Die[] };
    const s = diceTurnReducer(before, {
      type: 'TURN_BANKED', summary: { won: true, score: 600, isTutto: false },
    });

    expect(s.stopped).toBe(true);
    expect(s.showSummary).toBe(true);
    expect(s.summaryData).toEqual({ won: true, score: 600, isTutto: false });
    expect(s.turnScore).toBe(600);
    expect(s.keptDice).toBe(before.keptDice);
  });

  it('SUMMARY_SHOWN opens the summary WITHOUT the stopped marker — a bust is not a banked decision', () => {
    const s = diceTurnReducer({ ...baseState(), bustState: true }, {
      type: 'SUMMARY_SHOWN', summary: { won: false, score: 0, isTutto: false },
    });

    expect(s.showSummary).toBe(true);
    expect(s.summaryData).toEqual({ won: false, score: 0, isTutto: false });
    expect(s.stopped).toBe(false);
  });

  describe('CHAIN_DRAWN', () => {
    it('resets the table onto the chain total for the new card', () => {
      const s = diceTurnReducer(
        { ...baseState(), showSummary: true, bustState: true, kniffelProgress: [1, 2] },
        { type: 'CHAIN_DRAWN', card: '400', base: 750 },
      );

      expect(s.chainCardCount).toBe(2);
      expect(s.turnScore).toBe(750);
      expect(s.keptDice).toEqual([]);
      expect(s.currentRoll).toEqual([]);
      expect(s.kniffelProgress).toEqual([]);
      expect(s.bustState).toBe(false);
      expect(s.showSummary).toBe(false);
      expect(s.summaryData).toEqual({ won: false, score: 0, isTutto: false });
    });

    it('resets the tutto count only for a drawn Kleeblatt', () => {
      const at2 = { ...baseState(), tuttosThisTurn: 2 };

      expect(diceTurnReducer(at2, { type: 'CHAIN_DRAWN', card: 'Kleeblatt', base: 0 }).tuttosThisTurn).toBe(0);
      expect(diceTurnReducer(at2, { type: 'CHAIN_DRAWN', card: '500', base: 0 }).tuttosThisTurn).toBe(2);
    });

    it('leaves the summary data alone for a drawn Stop — the forfeit summary is set on dismissal', () => {
      const withSummary = { ...baseState(), summaryData: { won: true, score: 500, isTutto: true } };
      const s = diceTurnReducer(withSummary, { type: 'CHAIN_DRAWN', card: 'Stop', base: 500 });

      expect(s.summaryData).toEqual({ won: true, score: 500, isTutto: true });
      expect(s.showSummary).toBe(false);
    });
  });

  it('DRAW_ABANDONED takes the optimistic chain entry back out and banks the committed total', () => {
    const s = diceTurnReducer({ ...baseState(), chainCardCount: 3 }, {
      type: 'DRAW_ABANDONED', summary: { won: true, score: 900, isTutto: true },
    });

    expect(s.chainCardCount).toBe(2);
    expect(s.stopped).toBe(true);
    expect(s.showSummary).toBe(true);
    expect(s.summaryData).toEqual({ won: true, score: 900, isTutto: true });
  });
});
