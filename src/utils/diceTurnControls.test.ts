import { describe, it, expect } from 'vitest';
import { isSpecialCard, deriveTurnControls, sortKeptDiceForDisplay } from './diceTurnControls';

describe('diceTurnControls', () => {
  // Sensible defaults for a mid-turn state; override per assertion.
  const base = {
    currentCard: '300',
    hasRolled: true,
    isRolling: false,
    bustState: false,
    isMakingTutto: false,
    tuttosThisTurn: 0,
  };

  describe('isSpecialCard', () => {
    it('flags Kniffel, Plus_Minus and Kleeblatt', () => {
      ['Kniffel', 'Plus_Minus', 'Kleeblatt'].forEach(c => expect(isSpecialCard(c)).toBe(true));
    });
    it('treats normal/bonus cards as non-special', () => {
      ['300', 'x2', 'Feuerwerk', 'Stop'].forEach(c => expect(isSpecialCard(c)).toBe(false));
    });
  });

  describe('deriveTurnControls — canStop', () => {
    it('allows stopping on a normal card after rolling', () => {
      expect(deriveTurnControls(base).canStop).toBe(true);
    });

    it('blocks stopping while rolling, busted, or before a roll', () => {
      expect(deriveTurnControls({ ...base, isRolling: true }).canStop).toBe(false);
      expect(deriveTurnControls({ ...base, bustState: true }).canStop).toBe(false);
      expect(deriveTurnControls({ ...base, hasRolled: false }).canStop).toBe(false);
    });

    it('never allows stopping on Feuerwerk', () => {
      expect(deriveTurnControls({ ...base, currentCard: 'Feuerwerk' }).canStop).toBe(false);
    });

    it('on special cards only allows stopping when completing a Tutto', () => {
      expect(deriveTurnControls({ ...base, currentCard: 'Kniffel', isMakingTutto: false }).canStop).toBe(false);
      expect(deriveTurnControls({ ...base, currentCard: 'Kniffel', isMakingTutto: true }).canStop).toBe(true);
    });
  });

  describe('deriveTurnControls — isRollAgainApplicable', () => {
    it('is true when not making a Tutto', () => {
      expect(deriveTurnControls(base).isRollAgainApplicable).toBe(true);
    });

    it('is false when making a Tutto on a non-Feuerwerk card (auto-finishes instead)', () => {
      expect(deriveTurnControls({ ...base, isMakingTutto: true }).isRollAgainApplicable).toBe(false);
    });

    it('stays true when making a Tutto on Feuerwerk (keep rolling)', () => {
      expect(deriveTurnControls({ ...base, currentCard: 'Feuerwerk', isMakingTutto: true }).isRollAgainApplicable).toBe(true);
    });
  });

  describe('deriveTurnControls — stopButtonText', () => {
    it('defaults to Stop & Score', () => {
      expect(deriveTurnControls(base).stopButtonText).toEqual({ key: 'dice.stop_and_score', fallback: 'Stop & Score' });
    });

    it('shows Roll 2nd Tutto for the first Kleeblatt Tutto', () => {
      const r = deriveTurnControls({ ...base, currentCard: 'Kleeblatt', isMakingTutto: true, tuttosThisTurn: 0 });
      expect(r.stopButtonText).toEqual({ key: 'dice.roll_2nd_tutto', fallback: 'Roll 2nd Tutto' });
    });

    it('shows Finish Card for the second Kleeblatt Tutto', () => {
      const r = deriveTurnControls({ ...base, currentCard: 'Kleeblatt', isMakingTutto: true, tuttosThisTurn: 1 });
      expect(r.stopButtonText).toEqual({ key: 'dice.finish_card', fallback: 'Finish Card' });
    });

    it('shows Finish Card for a Tutto on other special cards', () => {
      const r = deriveTurnControls({ ...base, currentCard: 'Plus_Minus', isMakingTutto: true });
      expect(r.stopButtonText).toEqual({ key: 'dice.finish_card', fallback: 'Finish Card' });
    });
  });

  describe('sortKeptDiceForDisplay', () => {
    const dice = [{ val: 3 }, { val: 1 }, { val: 2 }];

    it('leaves order untouched for non-Kniffel cards', () => {
      expect(sortKeptDiceForDisplay(dice, '300', []).map(d => d.val)).toEqual([3, 1, 2]);
    });

    it('sorts ascending for a Kniffel sequence started at 1', () => {
      expect(sortKeptDiceForDisplay(dice, 'Kniffel', [1]).map(d => d.val)).toEqual([1, 2, 3]);
    });

    it('sorts descending for a Kniffel sequence started at 6', () => {
      const d = [{ val: 4 }, { val: 6 }, { val: 5 }];
      expect(sortKeptDiceForDisplay(d, 'Kniffel', [6]).map(x => x.val)).toEqual([6, 5, 4]);
    });

    it('does not sort Kniffel before any progress exists', () => {
      expect(sortKeptDiceForDisplay(dice, 'Kniffel', []).map(d => d.val)).toEqual([3, 1, 2]);
    });

    it('returns a new array (does not mutate input)', () => {
      const input = [{ val: 3 }, { val: 1 }];
      const out = sortKeptDiceForDisplay(input, 'Kniffel', [1]);
      expect(out).not.toBe(input);
      expect(input.map(d => d.val)).toEqual([3, 1]);
    });
  });
});
