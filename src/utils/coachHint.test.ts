/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { coachHint, type CoachHintInput } from './coachHint';
import { OPTIMAL_DRAW_BANK_LIMIT } from './botStrategies';
import { MAX_CHAIN_CARDS, type CardType } from '../types';

const input = (overrides: Partial<CoachHintInput> = {}): CoachHintInput => ({
  rollVals: [1, 5, 2, 2, 3, 4],
  keptCount: 0,
  turnScore: 0,
  currentCard: '200' as CardType,
  ruleset: 'modernized',
  kniffelProgress: [],
  standings: { myScore: 0, leaderScore: 0, winningScore: 6000 },
  isClassic: false,
  canDraw: false,
  chainCardCount: 0,
  tuttosThisTurn: 0,
  selectedIndices: [],
  isSelectionLocked: false,
  ...overrides,
});

describe('coachHint', () => {
  // The review's blocker: DiceGame's own availability booleans are all false
  // on a freshly landed roll (every die lands unselected), so a hint built
  // from the PLAYER's selection would never show at the moment it is
  // promised. The coach must derive availability from Otto's own pick
  // instead — this table's advice must be there with nothing tapped yet.
  it('advises on a fresh six-dice table although nothing is selected', () => {
    // Keeping the lone 1 leaves five dice; the bank is 100 (mirrors
    // botStrategies.test.ts's "rolls a full table of dice on a small bank").
    const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [] }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('roll');
    expect(hint!.keep).toEqual([1]);
  });

  it('advises stopping a 300-plus bank with few dice left', () => {
    // Four kept, the 5 makes the bank 350 and leaves one die: rolling it is
    // worth (1/3) * (350 + 75) = 142, well under the bank.
    const hint = coachHint(input({ keptCount: 4, rollVals: [5, 3], turnScore: 300 }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('stop');
    expect(hint!.bank).toBe(350);
  });

  it('advises drawing a classic tutto whose chain is still cheap to lose', () => {
    // Five kept on a 200 total, the sixth a 5: 250 plus the card's 200 = 450,
    // under OPTIMAL_DRAW_BANK_LIMIT.
    expect(OPTIMAL_DRAW_BANK_LIMIT).toBe(600);
    const hint = coachHint(input({
      ruleset: 'classic', isClassic: true, canDraw: true,
      keptCount: 5, rollVals: [5], turnScore: 200, chainCardCount: 0,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.action).toBe('draw');
    expect(hint!.bank).toBe(450);
  });

  it('will not advise drawing past MAX_CHAIN_CARDS — the panel refuses it too', () => {
    const hint = coachHint(input({
      ruleset: 'classic', isClassic: true, canDraw: true,
      keptCount: 5, rollVals: [5], turnScore: 200, chainCardCount: MAX_CHAIN_CARDS,
    }));
    expect(hint).not.toBeNull();
    expect(hint!.action).not.toBe('draw');
    expect(hint!.action).toBe('stop');
  });

  it('never counts Plus/Minus dice in the bank', () => {
    // Otto would keep the 1 and the 5 (150 pts elsewhere), but Plus/Minus
    // pays only for completion — the dice are discarded outright.
    const hint = coachHint(input({ currentCard: 'Plus_Minus', turnScore: 100 }));
    expect(hint).not.toBeNull();
    expect(hint!.bank).toBe(100);
  });

  it('is trailing only when the leader is actually ahead', () => {
    // Mirrors botStrategies.test.ts's "takes more risk the further behind".
    const level = coachHint(input({ keptCount: 3, rollVals: [1, 3, 4], turnScore: 200, standings: { myScore: 0, leaderScore: 0, winningScore: 6000 } }));
    expect(level).not.toBeNull();
    expect(level!.action).toBe('stop');
    expect(level!.trailing).toBe(false);

    const behind = coachHint(input({ keptCount: 3, rollVals: [1, 3, 4], turnScore: 200, standings: { myScore: 0, leaderScore: 3000, winningScore: 6000 } }));
    expect(behind).not.toBeNull();
    expect(behind!.action).toBe('roll');
    expect(behind!.trailing).toBe(true);
  });

  describe('selectionDiffers', () => {
    it('is false with no selection on the table', () => {
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [] }));
      expect(hint!.selectionDiffers).toBe(false);
    });

    it('is false while the selection is locked (a forced Feuerwerk keep)', () => {
      // Index 1 (the 2) is not part of Otto's pick ([0], the 1) — it would
      // read as a mismatch if the lock did not suppress it.
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [1], isSelectionLocked: true }));
      expect(hint!.selectionDiffers).toBe(false);
    });

    it('is true when the player has tapped a different die than Otto would keep', () => {
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [1] }));
      expect(hint!.selectionDiffers).toBe(true);
    });

    it('is false when the tap already matches Otto\'s own pick', () => {
      const hint = coachHint(input({ rollVals: [1, 2, 3, 4, 6, 6], selectedIndices: [0] }));
      expect(hint!.selectionDiffers).toBe(false);
    });
  });

  it('is null on a table that has nothing to keep', () => {
    // No 1, no 5, no completed triple — busts under the default rules.
    expect(coachHint(input({ rollVals: [2, 3, 4, 6, 6, 4] }))).toBeNull();
  });
});
