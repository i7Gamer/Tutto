/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { rollDie, isBust, checkKniffel, checkKniffelClassic, checkValidityAndScore, applyTuttoBonus, getMaxValidSelection } from './diceLogic';
import type { CardType } from '../types';

describe('diceLogic', () => {

  describe('isBust', () => {
    it('should return true for a roll with no 1s, 5s, or triplets', () => {
      expect(isBust([2, 3, 4, 6], "200", [])).toBe(true);
      expect(isBust([2, 3, 4, 2, 6, 6], "Stop", [])).toBe(true);
    });

    it('should return false if there is a 1 or a 5', () => {
      expect(isBust([2, 3, 1, 6], "200", [])).toBe(false);
      expect(isBust([2, 5, 4, 6], "Plus_Minus", [])).toBe(false);
    });

    it('should return false if there is a triplet', () => {
      expect(isBust([2, 2, 2, 4, 6], "200", [])).toBe(false);
      expect(isBust([3, 3, 3, 4, 6], "Stop", [])).toBe(false);
    });

    it('Kniffel: should return false if rolling a valid start (1 or 6)', () => {
      expect(isBust([1, 2, 3], "Kniffel", [])).toBe(false);
      expect(isBust([6, 5, 4], "Kniffel", [])).toBe(false);
    });

    it('Kniffel: should return true if no valid start is rolled', () => {
      expect(isBust([2, 3, 4, 5], "Kniffel", [])).toBe(true);
    });

    it('Kniffel: should return false if rolling the next needed number', () => {
      expect(isBust([2, 4, 5], "Kniffel", [1])).toBe(false); // building up, needs 2
      expect(isBust([5, 4, 3], "Kniffel", [6])).toBe(false); // building down, needs 5
    });

    it('Kniffel: should return true if missing the exact next number', () => {
      expect(isBust([3, 4, 5], "Kniffel", [1])).toBe(true); // needs 2, rolled 3, 4, 5
      expect(isBust([4, 3, 2], "Kniffel", [6])).toBe(true); // needs 5, rolled 4, 3, 2
      expect(isBust([6, 5, 4], "Kniffel", [1, 2])).toBe(true); // needs 3
    });

    it('returns false for all-triplet roll [2,2,2,3,3,3]', () => {
      expect(isBust([2, 2, 2, 3, 3, 3], "200", [])).toBe(false);
    });
  });

  describe('checkKniffel', () => {
    it('should validate starting with 1 and continuing up', () => {
      const res = checkKniffel([1, 2], []);
      expect(res.valid).toBe(true);
      expect(res.newProgress).toEqual([1, 2]);
    });

    it('should validate starting with 6 and continuing down', () => {
      const res = checkKniffel([6, 5], []);
      expect(res.valid).toBe(true);
      expect(res.newProgress).toEqual([6, 5]);
    });

    it('should reject invalid starts (e.g. 2, 3)', () => {
      const res = checkKniffel([2, 3], []);
      expect(res.valid).toBe(false);
      expect(res.newProgress).toEqual([]);
    });

    it('should reject skipping numbers', () => {
      const res = checkKniffel([1, 3], []);
      expect(res.valid).toBe(false);
      expect(res.newProgress).toEqual([]);
    });

    it('should resume building up from an existing sequence', () => {
      const res = checkKniffel([3, 4], [1, 2]);
      expect(res.valid).toBe(true);
      expect(res.newProgress).toEqual([1, 2, 3, 4]);
    });

    it('should resume building down from an existing sequence', () => {
      const res = checkKniffel([4, 3], [6, 5]);
      expect(res.valid).toBe(true);
      expect(res.newProgress).toEqual([6, 5, 4, 3]);
    });

    it('should reject wrong direction or skips when resuming', () => {
      const res = checkKniffel([4], [1, 2]);
      expect(res.valid).toBe(false);
      expect(res.newProgress).toEqual([1, 2]);
    });

    it('should handle unordered selections gracefully', () => {
      // User selects 3, 2, 1 in that order but submits it as a chunk [2, 1, 3]
      const res = checkKniffel([2, 1, 3], []);
      expect(res.valid).toBe(true);
      expect(res.newProgress).toEqual([1, 2, 3]);

      // Unordered building down [4, 6, 5]
      const resDesc = checkKniffel([4, 6, 5], []);
      expect(resDesc.valid).toBe(true);
      expect(resDesc.newProgress).toEqual([6, 5, 4]);
    });
  });

  describe('checkValidityAndScore', () => {
    it('returns valid: false for empty arrays', () => {
      expect(checkValidityAndScore([], "200", []).valid).toBe(false);
    });

    it('scores 1s and 5s correctly', () => {
      expect(checkValidityAndScore([1], "200", []).score).toBe(100);
      expect(checkValidityAndScore([5], "200", []).score).toBe(50);
      expect(checkValidityAndScore([1, 5], "200", []).score).toBe(150);
    });

    it('scores triplets correctly', () => {
      expect(checkValidityAndScore([2, 2, 2], "200", []).score).toBe(200);
      expect(checkValidityAndScore([3, 3, 3], "200", []).score).toBe(300);
      expect(checkValidityAndScore([4, 4, 4], "200", []).score).toBe(400);
      expect(checkValidityAndScore([6, 6, 6], "200", []).score).toBe(600);
      expect(checkValidityAndScore([1, 1, 1], "200", []).score).toBe(1000);
      expect(checkValidityAndScore([5, 5, 5], "200", []).score).toBe(500);
    });

    it('rejects invalid single/double dice (non-1/5)', () => {
      expect(checkValidityAndScore([2], "200", []).valid).toBe(false);
      expect(checkValidityAndScore([2, 2], "200", []).valid).toBe(false);
      expect(checkValidityAndScore([1, 2], "200", []).valid).toBe(false);
      expect(checkValidityAndScore([3, 3, 3, 4], "200", []).valid).toBe(false);
    });

    it('rejects a selection with more than a complete triplet of the same value (4 or 5 of a kind)', () => {
      // Only complete triplets of 2/3/4/6 may be banked — the 4th/5th die does
      // not score and therefore cannot be part of a valid selection. (A ROLL
      // containing four 2s is still safe — isBust only needs one triplet.)
      expect(checkValidityAndScore([2, 2, 2, 2], "200", []).valid).toBe(false);
      expect(checkValidityAndScore([6, 6, 6, 6, 6], "200", []).valid).toBe(false);
      // ...while two full triplets stay valid.
      expect(checkValidityAndScore([2, 2, 2, 2, 2, 2], "200", []).valid).toBe(true);
    });

    it('scores combinations of triplets and singles correctly', () => {
      expect(checkValidityAndScore([2, 2, 2, 1, 5], "200", []).score).toBe(350); // 200 + 100 + 50
      expect(checkValidityAndScore([1, 1, 1, 5, 5, 5], "200", []).score).toBe(1500); // 1000 + 500
    });

    it('scores 6-dice Tutto combinations correctly', () => {
      expect(checkValidityAndScore([2, 2, 2, 3, 3, 3], "200", []).score).toBe(500); // 200 + 300
    });

    it('delegates Kniffel validation to checkKniffel and forces score to 0', () => {
      const res = checkValidityAndScore([1, 2], "Kniffel", []);
      expect(res.valid).toBe(true);
      expect(res.score).toBe(0); // Kniffel scores are only applied on success (2000 points)
      expect(res.newKniffelProgress).toEqual([1, 2]);

      const failRes = checkValidityAndScore([2, 3], "Kniffel", []);
      expect(failRes.valid).toBe(false);
      expect(failRes.score).toBe(0);
    });
  });

  describe('applyTuttoBonus', () => {
    it('applies fixed bonus cards correctly', () => {
      expect(applyTuttoBonus(1000, "200")).toBe(1200);
      expect(applyTuttoBonus(500, "600")).toBe(1100);
    });

    it('applies x2 multiplier correctly', () => {
      expect(applyTuttoBonus(1500, "x2")).toBe(3000);
    });

    it('does not multiply if score is 0 on x2 (e.g., getting a Tutto via Feuerwerk without scoring points)', () => {
      expect(applyTuttoBonus(0, "x2")).toBe(0);
    });

    it('does nothing for non-bonus cards (like Feuerwerk or Kleeblatt)', () => {
      expect(applyTuttoBonus(1000, "Feuerwerk")).toBe(1000);
      expect(applyTuttoBonus(0, "Kleeblatt")).toBe(0);
    });
  });

  describe('getMaxValidSelection', () => {
    // Maps selected indices back to the dice values they point at.
    const selectedVals = (roll: number[], card: CardType | null, progress: number[] = []) =>
      getMaxValidSelection(roll, card, progress).map(i => roll[i]);

    it('selects all 1s and 5s', () => {
      expect(selectedVals([1, 5, 1, 5], "200").sort()).toEqual([1, 1, 5, 5]);
    });

    it('ignores non-scoring 2/3/4/6 singles and pairs', () => {
      expect(getMaxValidSelection([2, 3, 4, 6], "200")).toEqual([]);
      expect(getMaxValidSelection([2, 2, 3, 3], "200")).toEqual([]);
    });

    it('selects complete triplets of 2/3/4/6', () => {
      expect(selectedVals([2, 2, 2, 4, 6], "200")).toEqual([2, 2, 2]);
      expect(selectedVals([3, 3, 3, 3, 3, 3], "200")).toEqual([3, 3, 3, 3, 3, 3]);
    });

    it('selects only complete groups of three, leaving the remainder', () => {
      // Four 2s -> only the first three are taken (4 % 3 = 1 left out).
      expect(selectedVals([2, 2, 2, 2, 1, 5].slice(), "200").sort()).toEqual([1, 2, 2, 2, 5]);
    });

    it('combines singles and triplets into one valid scoring selection', () => {
      const roll = [1, 5, 2, 2, 2, 3];
      const sel = selectedVals(roll, "200");
      expect(sel.sort()).toEqual([1, 2, 2, 2, 5]);
      // The selection must actually be scoreable.
      expect(checkValidityAndScore(sel, "200", []).valid).toBe(true);
    });

    it('returns indices (not values), unique and in range', () => {
      const roll = [1, 1, 2, 2, 2, 5];
      const idx = getMaxValidSelection(roll, "200");
      expect(new Set(idx).size).toBe(idx.length);
      idx.forEach(i => expect(i).toBeGreaterThanOrEqual(0));
      idx.forEach(i => expect(i).toBeLessThan(roll.length));
    });

    it('returns empty selection on a bust roll', () => {
      expect(getMaxValidSelection([2, 3, 4, 6], "300")).toEqual([]);
    });

    describe('Kniffel', () => {
      it('starts an ascending run from 1', () => {
        expect(selectedVals([1, 2, 3, 6, 6, 6], "Kniffel", [])).toEqual([1, 2, 3]);
      });

      it('starts a descending run from 6', () => {
        expect(selectedVals([6, 5, 4, 2, 2, 1], "Kniffel", [])).toEqual([6, 5, 4]);
      });

      it('picks the longer run when both 1 and 6 are present', () => {
        // ascending from 1: just [1]; descending from 6: [6,5,4]
        expect(selectedVals([1, 6, 5, 4, 3, 3], "Kniffel", [])).toEqual([6, 5, 4, 3]);
      });

      it('continues an ascending sequence from progress', () => {
        expect(selectedVals([3, 4, 5, 1, 1, 1], "Kniffel", [1, 2])).toEqual([3, 4, 5]);
      });

      it('continues a descending sequence from progress', () => {
        expect(selectedVals([4, 3, 6, 6, 6, 6], "Kniffel", [6, 5])).toEqual([4, 3]);
      });

      it('returns empty when the next needed number is missing', () => {
        expect(getMaxValidSelection([4, 5, 6], "Kniffel", [1])).toEqual([]); // needs 2
      });

      it('selects all 6 dice when the full 1–6 sequence is present regardless of dice order', () => {
        // Both the ascending (1→6) and descending (6→1) traversals find every value in
        // [1,2,3,6,5,4] — neither path skips dice. The tie-break (ascending wins on >=)
        // is inconsequential because both cover the same six dice.
        const roll = [1, 2, 3, 6, 5, 4];
        const indices = getMaxValidSelection(roll, 'Kniffel', []);
        expect(indices.length).toBe(6);
        expect(new Set(indices).size).toBe(6); // all unique
        const vals = indices.map(i => roll[i]).sort((a, b) => a - b);
        expect(vals).toEqual([1, 2, 3, 4, 5, 6]);
      });

      it('produces a selection that checkKniffel accepts', () => {
        const roll = [3, 4, 5, 2, 2, 2];
        const sel = selectedVals(roll, "Kniffel", [1, 2]);
        expect(checkKniffel(sel, [1, 2]).valid).toBe(true);
      });
    });
  });

  describe('rollDie', () => {
    it('always returns an integer in [1, 6]', () => {
      for (let i = 0; i < 100; i++) {
        const v = rollDie();
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(6);
        expect(Number.isInteger(v)).toBe(true);
      }
    });
  });

  describe('calculateKniffel - missing branches', () => {
    it('returns invalid if starting from 6 but the sequence breaks immediately', () => {
      // Trying to start a sequence from 6, but the dice is [6, 4] instead of [6, 5]
      const result = checkKniffel([6, 4], []);
      expect(result.valid).toBe(false);
    });

    it('returns invalid if continuing a descending sequence but the sequence breaks', () => {
      // Progress is [6, 5], trying to add [3] instead of [4]
      const result = checkKniffel([3], [6, 5]);
      expect(result.valid).toBe(false);
    });
  });

  // ─── Classic (official) straight: any missing number is a valid die ───────

  describe('checkKniffelClassic', () => {
    it('accepts any single missing number, in any order', () => {
      expect(checkKniffelClassic([3], [])).toEqual({ valid: true, newProgress: [3] });
      expect(checkKniffelClassic([6], [3])).toEqual({ valid: true, newProgress: [3, 6] });
      expect(checkKniffelClassic([1], [3, 6])).toEqual({ valid: true, newProgress: [1, 3, 6] });
    });

    it('accepts several missing numbers in one selection, keeping progress sorted', () => {
      expect(checkKniffelClassic([5, 2], [3])).toEqual({ valid: true, newProgress: [2, 3, 5] });
    });

    it('rejects a die whose number is already collected', () => {
      expect(checkKniffelClassic([3], [3])).toEqual({ valid: false, newProgress: [3] });
    });

    it('rejects duplicates within one selection (only one die may count per number)', () => {
      expect(checkKniffelClassic([2, 2], [])).toEqual({ valid: false, newProgress: [] });
    });

    it('rejects a mixed selection containing one invalid die, leaving progress untouched', () => {
      expect(checkKniffelClassic([4, 3], [3])).toEqual({ valid: false, newProgress: [3] });
    });

    it('rejects an empty selection', () => {
      expect(checkKniffelClassic([], [1, 2])).toEqual({ valid: false, newProgress: [1, 2] });
    });

    it('completes the straight from a non-consecutive collection (the 2004 rulebook example)', () => {
      // The official example collects 1,2,3 then 6 then 5 and finally needs
      // the 4 — impossible under the modernized consecutive-run rule.
      expect(checkKniffelClassic([4], [1, 2, 3, 5, 6]))
        .toEqual({ valid: true, newProgress: [1, 2, 3, 4, 5, 6] });
    });
  });

  describe('isBust — classic Kniffel', () => {
    it('never busts on the first roll (every number is still missing)', () => {
      expect(isBust([2, 2, 4, 4, 3, 3], 'Kniffel', [], 'classic')).toBe(false);
    });

    it('busts only when every rolled value is already collected', () => {
      expect(isBust([1, 2, 3, 1, 2], 'Kniffel', [1, 2, 3], 'classic')).toBe(true);
      expect(isBust([1, 2, 4], 'Kniffel', [1, 2, 3], 'classic')).toBe(false);
    });

    it('a roll the modernized rule busts can be fine under classic', () => {
      // Progress [1,2]: modernized needs exactly a 3; classic takes the 5.
      expect(isBust([5, 5], 'Kniffel', [1, 2], 'modernized')).toBe(true);
      expect(isBust([5, 5], 'Kniffel', [1, 2], 'classic')).toBe(false);
    });

    it('defaults to the modernized rule when no ruleset is passed', () => {
      expect(isBust([5, 5], 'Kniffel', [1, 2])).toBe(true);
    });
  });

  describe('checkValidityAndScore — classic Kniffel routing', () => {
    it('routes Kniffel to the classic checker and always scores 0', () => {
      const r = checkValidityAndScore([6, 2], 'Kniffel', [3], 'classic');
      expect(r).toEqual({ valid: true, score: 0, newKniffelProgress: [2, 3, 6] });
    });

    it('keeps the modernized consecutive rule when no ruleset is passed', () => {
      expect(checkValidityAndScore([3], 'Kniffel', [1]).valid).toBe(false);
      expect(checkValidityAndScore([2], 'Kniffel', [1]).valid).toBe(true);
    });

    it('scores non-Kniffel cards identically under both rulesets', () => {
      const vals = [1, 5, 2, 2, 2];
      expect(checkValidityAndScore(vals, '300', [], 'classic'))
        .toEqual(checkValidityAndScore(vals, '300', [], 'modernized'));
    });
  });

  describe('getMaxValidSelection — classic Kniffel', () => {
    it('picks one die per missing number, leaving duplicates in the pool', () => {
      // roll [1,3,3,5,6]: one of each missing number, the second 3 stays.
      expect(getMaxValidSelection([1, 3, 3, 5, 6], 'Kniffel', [], 'classic')).toEqual([0, 1, 3, 4]);
    });

    it('respects the already-collected numbers', () => {
      expect(getMaxValidSelection([2, 2, 4], 'Kniffel', [1, 3, 4, 5, 6], 'classic')).toEqual([0]);
    });

    it('returns an empty selection when every rolled value is collected (the bust case)', () => {
      expect(getMaxValidSelection([1, 1], 'Kniffel', [1, 2, 3], 'classic')).toEqual([]);
    });

    it('keeps the modernized run behavior when no ruleset is passed', () => {
      // Modernized picks the longer consecutive run: descending 6,5 (indices
      // 4,3) beats the lone ascending 1 — while classic above takes all four
      // distinct numbers.
      expect(getMaxValidSelection([1, 3, 3, 5, 6], 'Kniffel', [])).toEqual([4, 3]);
    });
  });
});
