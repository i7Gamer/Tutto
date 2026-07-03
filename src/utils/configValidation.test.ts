import { describe, it, expect } from 'vitest';
import {
  VALID_CARD_TYPES,
  MAX_CARD_COUNT,
  DEFAULT_INITIAL_CARDS,
  DEFAULT_WINNING_SCORE,
  DEFAULT_TURN_DURATION,
  DEFAULT_RECONNECT_TIMEOUT,
  MIN_WINNING_SCORE,
  MAX_WINNING_SCORE,
  MIN_ENABLED_TURN_DURATION,
  MAX_TURN_DURATION,
  MIN_ENABLED_RECONNECT_TIMEOUT,
  MAX_RECONNECT_TIMEOUT,
  isValidWinningScore,
  isValidTurnDuration,
  isValidReconnectTimeout,
  isValidCardEntry,
  isValidEnforcedDiceMode,
  snapDisableableDuration,
} from './configValidation';

describe('configValidation', () => {
  // ─── Constants ──────────────────────────────────────────────────────────────

  describe('shared game-config defaults', () => {
    // These are the single source of truth for both the client store's initial
    // state and the server's new-room defaults — they must always satisfy the
    // validators both sides use to accept config.
    it('DEFAULT_INITIAL_CARDS defines a valid count for every card type', () => {
      expect(Object.keys(DEFAULT_INITIAL_CARDS).sort()).toEqual([...VALID_CARD_TYPES].sort());
      for (const [key, val] of Object.entries(DEFAULT_INITIAL_CARDS)) {
        expect(isValidCardEntry(key, val)).toBe(true);
      }
    });

    it('DEFAULT_INITIAL_CARDS is a playable (non-empty) deck', () => {
      expect(Object.values(DEFAULT_INITIAL_CARDS).some(count => (count ?? 0) > 0)).toBe(true);
    });

    it('default score/timer values pass their own validators', () => {
      expect(isValidWinningScore(DEFAULT_WINNING_SCORE)).toBe(true);
      expect(isValidTurnDuration(DEFAULT_TURN_DURATION)).toBe(true);
      expect(isValidReconnectTimeout(DEFAULT_RECONNECT_TIMEOUT)).toBe(true);
    });
  });

  describe('VALID_CARD_TYPES', () => {
    it('contains exactly 11 entries', () => {
      expect(VALID_CARD_TYPES).toHaveLength(11);
    });

    it('contains every expected card type', () => {
      const expected = [
        'Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2',
        '200', '300', '400', '500', '600',
      ];
      for (const type of expected) {
        expect(VALID_CARD_TYPES).toContain(type);
      }
    });
  });

  describe('MAX_CARD_COUNT', () => {
    it('equals 99', () => {
      expect(MAX_CARD_COUNT).toBe(99);
    });
  });

  describe('range constants match their validators', () => {
    // The constants are what the lobby inputs clamp against; the validators are
    // what the server accepts. The boundaries must agree exactly or a value the
    // UI commits could be silently rejected server-side again.
    it('winning score boundaries', () => {
      expect(isValidWinningScore(MIN_WINNING_SCORE)).toBe(true);
      expect(isValidWinningScore(MIN_WINNING_SCORE - 1)).toBe(false);
      expect(isValidWinningScore(MAX_WINNING_SCORE)).toBe(true);
      expect(isValidWinningScore(MAX_WINNING_SCORE + 1)).toBe(false);
    });

    it('turn duration boundaries', () => {
      expect(isValidTurnDuration(MIN_ENABLED_TURN_DURATION)).toBe(true);
      expect(isValidTurnDuration(MIN_ENABLED_TURN_DURATION - 1)).toBe(false);
      expect(isValidTurnDuration(MAX_TURN_DURATION)).toBe(true);
      expect(isValidTurnDuration(MAX_TURN_DURATION + 1)).toBe(false);
    });

    it('reconnect timeout boundaries', () => {
      expect(isValidReconnectTimeout(MIN_ENABLED_RECONNECT_TIMEOUT)).toBe(true);
      expect(isValidReconnectTimeout(MIN_ENABLED_RECONNECT_TIMEOUT - 1)).toBe(false);
      expect(isValidReconnectTimeout(MAX_RECONNECT_TIMEOUT)).toBe(true);
      expect(isValidReconnectTimeout(MAX_RECONNECT_TIMEOUT + 1)).toBe(false);
    });
  });

  // ─── snapDisableableDuration ────────────────────────────────────────────────

  describe('snapDisableableDuration', () => {
    it('keeps 0 (disabled) as-is', () => {
      expect(snapDisableableDuration(0, MIN_ENABLED_TURN_DURATION)).toBe(0);
    });

    it('snaps values inside the 1..minEnabled-1 gap up to minEnabled', () => {
      expect(snapDisableableDuration(1, MIN_ENABLED_TURN_DURATION)).toBe(MIN_ENABLED_TURN_DURATION);
      expect(snapDisableableDuration(MIN_ENABLED_TURN_DURATION - 1, MIN_ENABLED_TURN_DURATION)).toBe(MIN_ENABLED_TURN_DURATION);
    });

    it('keeps values at or above minEnabled unchanged', () => {
      expect(snapDisableableDuration(MIN_ENABLED_TURN_DURATION, MIN_ENABLED_TURN_DURATION)).toBe(MIN_ENABLED_TURN_DURATION);
      expect(snapDisableableDuration(120, MIN_ENABLED_TURN_DURATION)).toBe(120);
    });

    it('every snapped output passes the matching validator', () => {
      for (let v = 0; v <= 20; v++) {
        expect(isValidTurnDuration(snapDisableableDuration(v, MIN_ENABLED_TURN_DURATION))).toBe(true);
        expect(isValidReconnectTimeout(snapDisableableDuration(v, MIN_ENABLED_RECONNECT_TIMEOUT))).toBe(true);
      }
    });
  });

  // ─── isValidWinningScore ────────────────────────────────────────────────────

  describe('isValidWinningScore', () => {
    it('accepts the minimum boundary (1000)', () => {
      expect(isValidWinningScore(1000)).toBe(true);
    });

    it('rejects one below the minimum (999)', () => {
      expect(isValidWinningScore(999)).toBe(false);
    });

    it('accepts a mid-range value (6000)', () => {
      expect(isValidWinningScore(6000)).toBe(true);
    });

    it('accepts the maximum boundary (99999)', () => {
      expect(isValidWinningScore(99999)).toBe(true);
    });

    it('rejects one above the maximum (100000)', () => {
      expect(isValidWinningScore(100000)).toBe(false);
    });

    it('rejects NaN', () => {
      expect(isValidWinningScore(NaN)).toBe(false);
    });

    it('rejects Infinity', () => {
      expect(isValidWinningScore(Infinity)).toBe(false);
    });

    it('rejects a string', () => {
      expect(isValidWinningScore('6000')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidWinningScore(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isValidWinningScore(undefined)).toBe(false);
    });
  });

  // ─── isValidTurnDuration ────────────────────────────────────────────────────

  describe('isValidTurnDuration', () => {
    it('accepts 0 (disabled)', () => {
      expect(isValidTurnDuration(0)).toBe(true);
    });

    it('rejects 9 (gap between disabled and minimum active)', () => {
      expect(isValidTurnDuration(9)).toBe(false);
    });

    it('accepts the minimum active boundary (10)', () => {
      expect(isValidTurnDuration(10)).toBe(true);
    });

    it('accepts a mid-range value (120)', () => {
      expect(isValidTurnDuration(120)).toBe(true);
    });

    it('accepts the maximum boundary (600)', () => {
      expect(isValidTurnDuration(600)).toBe(true);
    });

    it('rejects one above the maximum (601)', () => {
      expect(isValidTurnDuration(601)).toBe(false);
    });

    it('rejects negative values (-1)', () => {
      expect(isValidTurnDuration(-1)).toBe(false);
    });

    it('rejects NaN', () => {
      expect(isValidTurnDuration(NaN)).toBe(false);
    });

    it('rejects Infinity', () => {
      expect(isValidTurnDuration(Infinity)).toBe(false);
    });

    it('rejects a string', () => {
      expect(isValidTurnDuration('120')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidTurnDuration(null)).toBe(false);
    });
  });

  // ─── isValidReconnectTimeout ────────────────────────────────────────────────

  describe('isValidReconnectTimeout', () => {
    it('accepts 0 (disabled)', () => {
      expect(isValidReconnectTimeout(0)).toBe(true);
    });

    it('rejects 9 (gap between disabled and minimum active)', () => {
      expect(isValidReconnectTimeout(9)).toBe(false);
    });

    it('accepts the minimum active boundary (10)', () => {
      expect(isValidReconnectTimeout(10)).toBe(true);
    });

    it('accepts a mid-range value (60)', () => {
      expect(isValidReconnectTimeout(60)).toBe(true);
    });

    it('accepts the maximum boundary (3600)', () => {
      expect(isValidReconnectTimeout(3600)).toBe(true);
    });

    it('rejects one above the maximum (3601)', () => {
      expect(isValidReconnectTimeout(3601)).toBe(false);
    });

    it('rejects negative values (-1)', () => {
      expect(isValidReconnectTimeout(-1)).toBe(false);
    });

    it('rejects NaN', () => {
      expect(isValidReconnectTimeout(NaN)).toBe(false);
    });

    it('rejects Infinity', () => {
      expect(isValidReconnectTimeout(Infinity)).toBe(false);
    });

    it('rejects a string', () => {
      expect(isValidReconnectTimeout('60')).toBe(false);
    });

    it('rejects null', () => {
      expect(isValidReconnectTimeout(null)).toBe(false);
    });
  });

  // ─── isValidCardEntry ───────────────────────────────────────────────────────

  describe('isValidCardEntry', () => {
    it('accepts a valid card type with count 0', () => {
      expect(isValidCardEntry('Stop', 0)).toBe(true);
    });

    it('accepts the maximum count (99)', () => {
      expect(isValidCardEntry('Feuerwerk', 99)).toBe(true);
    });

    it('rejects count 100 (above MAX_CARD_COUNT)', () => {
      expect(isValidCardEntry('Feuerwerk', 100)).toBe(false);
    });

    it('rejects a negative count (-1)', () => {
      expect(isValidCardEntry('Stop', -1)).toBe(false);
    });

    it('rejects an unknown card type', () => {
      expect(isValidCardEntry('Bogus', 5)).toBe(false);
    });

    it('rejects a non-integer float', () => {
      expect(isValidCardEntry('Stop', 1.5)).toBe(false);
    });

    it('rejects a string value', () => {
      expect(isValidCardEntry('Stop', '5')).toBe(false);
    });

    it('rejects null value', () => {
      expect(isValidCardEntry('Stop', null)).toBe(false);
    });

    it('rejects undefined value', () => {
      expect(isValidCardEntry('Stop', undefined)).toBe(false);
    });

    it('accepts all 11 canonical card types', () => {
      const validCounts = [
        'Kleeblatt', 'Feuerwerk', 'Stop', 'Kniffel', 'Plus_Minus', 'x2',
        '200', '300', '400', '500', '600',
      ];
      for (const type of validCounts) {
        expect(isValidCardEntry(type, 5)).toBe(true);
      }
    });

    it('rejects an empty string key', () => {
      expect(isValidCardEntry('', 5)).toBe(false);
    });
  });

  // ─── isValidEnforcedDiceMode ────────────────────────────────────────────────

  describe('isValidEnforcedDiceMode', () => {
    it('accepts null (not enforced)', () => {
      expect(isValidEnforcedDiceMode(null)).toBe(true);
    });

    it('accepts "digital"', () => {
      expect(isValidEnforcedDiceMode('digital')).toBe(true);
    });

    it('accepts "physical"', () => {
      expect(isValidEnforcedDiceMode('physical')).toBe(true);
    });

    it('rejects undefined', () => {
      expect(isValidEnforcedDiceMode(undefined)).toBe(false);
    });

    it('rejects an arbitrary string', () => {
      expect(isValidEnforcedDiceMode('digitall')).toBe(false);
    });

    it('rejects a boolean', () => {
      expect(isValidEnforcedDiceMode(true)).toBe(false);
    });

    it('rejects a number', () => {
      expect(isValidEnforcedDiceMode(1)).toBe(false);
    });
  });
});
