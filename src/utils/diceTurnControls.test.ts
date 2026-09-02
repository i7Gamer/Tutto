/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { isSpecialCard, hasScoreInput, deriveTurnControls, sortKeptDiceForDisplay, withForcedFeuerwerkSelection, parseScoreInput, clampScoreInputText } from './diceTurnControls';
import { MAX_SCORE_MAGNITUDE } from './configValidation';
import { VALID_CARD_TYPES } from './configValidation';
import type { CardType, Die } from '../types';

describe('diceTurnControls', () => {
  // Sensible defaults for a mid-turn state; override per assertion.
  const base = {
    currentCard: '300' as CardType,
    hasRolled: true,
    bustState: false,
    isMakingTutto: false,
    tuttosThisTurn: 0,
  };

  describe('isSpecialCard', () => {
    it('flags Kniffel, Plus_Minus and Kleeblatt', () => {
      (['Kniffel', 'Plus_Minus', 'Kleeblatt'] as CardType[]).forEach(c => expect(isSpecialCard(c)).toBe(true));
    });
    it('treats normal/bonus cards as non-special', () => {
      (['300', 'x2', 'Feuerwerk', 'Stop'] as CardType[]).forEach(c => expect(isSpecialCard(c)).toBe(false));
    });
  });

  describe('hasScoreInput', () => {
    // Game.tsx (which key does Space press?) and GameControls.tsx (which
    // control is on screen?) both ask this, and an answer that differed
    // between them would fire an action the player cannot see.
    it('offers a score entry on the cards that are played for points', () => {
      (['300', 'x2', 'Feuerwerk'] as CardType[]).forEach(c => expect(hasScoreInput(c)).toBe(true));
    });

    it('offers none on Stop, which ends the turn, or on the answered cards', () => {
      (['Stop', 'Kniffel', 'Plus_Minus', 'Kleeblatt'] as CardType[]).forEach(c => expect(hasScoreInput(c)).toBe(false));
    });

    it('offers one when no card is drawn yet, as the controls did before', () => {
      expect(hasScoreInput(null)).toBe(true);
    });

    it('gives every card exactly one way to be resolved', () => {
      // Score entry, a yes/no answer, or Stop — never two, never none.
      for (const card of VALID_CARD_TYPES) {
        const ways = [hasScoreInput(card), isSpecialCard(card), card === 'Stop'];
        expect(ways.filter(Boolean)).toHaveLength(1);
      }
    });
  });

  describe('deriveTurnControls — canStop', () => {
    it('allows stopping on a normal card after rolling', () => {
      expect(deriveTurnControls(base).canStop).toBe(true);
    });

    it('blocks stopping while busted or before a roll', () => {
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
    // These tests only ever assert on `val`; `id` just has to be present and
    // unique within one array of kept dice.
    const mkDice = (...vals: number[]): Die[] => vals.map((val, i) => ({ id: `d${i}`, val }));
    const dice = mkDice(3, 1, 2);

    it('leaves order untouched for non-Kniffel cards', () => {
      expect(sortKeptDiceForDisplay(dice, '300', []).map(d => d.val)).toEqual([3, 1, 2]);
    });

    it('sorts ascending for a Kniffel sequence started at 1', () => {
      expect(sortKeptDiceForDisplay(dice, 'Kniffel', [1]).map(d => d.val)).toEqual([1, 2, 3]);
    });

    it('sorts descending for a Kniffel sequence started at 6', () => {
      const d = mkDice(4, 6, 5);
      expect(sortKeptDiceForDisplay(d, 'Kniffel', [6]).map(x => x.val)).toEqual([6, 5, 4]);
    });

    it('does not sort Kniffel before any progress exists', () => {
      expect(sortKeptDiceForDisplay(dice, 'Kniffel', []).map(d => d.val)).toEqual([3, 1, 2]);
    });

    it('returns a new array (does not mutate input)', () => {
      const input = mkDice(3, 1);
      const out = sortKeptDiceForDisplay(input, 'Kniffel', [1]);
      expect(out).not.toBe(input);
      expect(input.map(d => d.val)).toEqual([3, 1]);
    });

    it('classic: always sorts ascending, whatever number was collected first', () => {
      // Classic progress is a set — the run-direction heuristic (progress[0]
      // === 1 ? asc : desc) would sort descending here just because the
      // first collected number happened to be a 6.
      const d = mkDice(6, 3, 5);
      expect(sortKeptDiceForDisplay(d, 'Kniffel', [6, 3], 'classic').map(x => x.val)).toEqual([3, 5, 6]);
    });

    it('classic: sorts even before any progress exists', () => {
      expect(sortKeptDiceForDisplay(dice, 'Kniffel', [], 'classic').map(d => d.val)).toEqual([1, 2, 3]);
    });
  });
});

describe('withForcedFeuerwerkSelection', () => {
  const roll = (...vals: number[]) => vals.map((val, i) => ({ id: `d${i}`, val, selected: false }));

  it('selects every scoring die and nothing else', () => {
    const forced = withForcedFeuerwerkSelection(roll(1, 2, 5, 3), 'classic');

    expect(forced.map(d => d.selected)).toEqual([true, false, true, false]);
  });

  it('selects a scoring triple along with the singles', () => {
    const forced = withForcedFeuerwerkSelection(roll(2, 2, 2, 5), 'classic');

    expect(forced.map(d => d.selected)).toEqual([true, true, true, true]);
  });

  it('overwrites a stale selection rather than adding to it', () => {
    const stale = [{ id: 'd0', val: 2, selected: true }, { id: 'd1', val: 1, selected: false }];

    expect(withForcedFeuerwerkSelection(stale, 'classic').map(d => d.selected)).toEqual([false, true]);
  });
});

describe('parseScoreInput', () => {
  it('reads an untouched box as no score', () => {
    expect(parseScoreInput('')).toBe(0);
  });

  it('reads a typed zero as zero', () => {
    expect(parseScoreInput('0')).toBe(0);
  });

  it('reads a normal entry as its number', () => {
    expect(parseScoreInput('350')).toBe(350);
  });

  it('clamps a negative entry to zero rather than subtracting from the total', () => {
    expect(parseScoreInput('-5')).toBe(0);
  });

  it('keeps the leading digits of a part-numeric entry', () => {
    expect(parseScoreInput('12abc')).toBe(12);
  });

  it('reads a non-numeric entry as no score instead of NaN', () => {
    expect(parseScoreInput('abc')).toBe(0);
  });

  // Bug: MAX_SCORE_INPUT_LENGTH (7 digits) let a physical score box hold up
  // to 9,999,999 while the server's own MAX_SCORE_MAGNITUDE bound is
  // 1,000,000 — both are 7 digits, so the length cap alone never caught it.
  // The server then dropped score/previousScore field-wise but kept the rest
  // of the pushed state, silently desyncing the client and server totals.
  it('clamps a value above the shared server maximum down to it', () => {
    expect(parseScoreInput('9999999')).toBe(MAX_SCORE_MAGNITUDE);
  });

  it('reads the maximum itself unclamped', () => {
    expect(parseScoreInput(String(MAX_SCORE_MAGNITUDE))).toBe(MAX_SCORE_MAGNITUDE);
  });
});

describe('clampScoreInputText', () => {
  it('leaves an untouched box empty rather than turning it into "0"', () => {
    expect(clampScoreInputText('')).toBe('');
  });

  it('leaves a value under the maximum untouched', () => {
    expect(clampScoreInputText('350')).toBe('350');
  });

  // The score box must never DISPLAY a number larger than what will actually
  // be committed — showing "9999999" while parseScoreInput quietly banks
  // 1,000,000 at Next Turn would be its own silent-desync bug between what
  // the player sees and what the server accepts.
  it('clamps a typed value above the maximum down to it, as text', () => {
    expect(clampScoreInputText('9999999')).toBe(String(MAX_SCORE_MAGNITUDE));
  });

  it('clamps a negative-looking entry to "0"', () => {
    expect(clampScoreInputText('-5')).toBe('0');
  });
});
