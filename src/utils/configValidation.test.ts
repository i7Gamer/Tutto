/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import {
  VALID_CARD_TYPES,
  BONUS_CARDS,
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
  isValidDiceMode,
  isValidRuleset,
  DEFAULT_DICE_MODE,
  DEFAULT_RULESET,
  snapDisableableDuration,
  areInitialCardsEqual,
  isNormalizedConfig,
  normalizeRoomId,
  MAX_ROOM_ID_LENGTH,
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

  describe('BONUS_CARDS', () => {
    it('lists only real card types', () => {
      for (const card of BONUS_CARDS) {
        expect(VALID_CARD_TYPES).toContain(card);
      }
    });

    it('names each card after the bonus it awards', () => {
      // applyTuttoBonus (diceLogic.ts) adds parseInt(card) to the turn score,
      // so a non-numeric entry here would silently score NaN.
      for (const card of BONUS_CARDS) {
        expect(Number(card)).toBeGreaterThan(0);
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

    // Both are whole seconds everywhere they are used — the lobby's number
    // inputs, the server's setTimeout, the displayed countdown. These two were
    // the only config validators checking `typeof v === 'number'` instead of
    // Number.isInteger, so a fractional value passed and left a sub-second
    // residual on the timer it armed.
    it('the two timers take whole seconds only', () => {
      expect(isValidTurnDuration(120.5)).toBe(false);
      expect(isValidReconnectTimeout(60.5)).toBe(false);

      expect(isValidTurnDuration(120)).toBe(true);
      expect(isValidReconnectTimeout(60)).toBe(true);
      // 0 stays the "disabled" value on both.
      expect(isValidTurnDuration(0)).toBe(true);
      expect(isValidReconnectTimeout(0)).toBe(true);
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

    it('rejects a non-integer within range', () => {
      expect(isValidWinningScore(6000.5)).toBe(false);
      expect(isValidWinningScore(1000.1)).toBe(false);
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

  // ─── isValidDiceMode / DEFAULT_DICE_MODE ───────────────────────────────────

  describe('isValidDiceMode', () => {
    it('accepts "physical" and "digital"', () => {
      expect(isValidDiceMode('physical')).toBe(true);
      expect(isValidDiceMode('digital')).toBe(true);
    });

    it('rejects null, undefined, and any other value', () => {
      expect(isValidDiceMode(null)).toBe(false);
      expect(isValidDiceMode(undefined)).toBe(false);
      expect(isValidDiceMode('')).toBe(false);
      expect(isValidDiceMode('bogus')).toBe(false);
      expect(isValidDiceMode(1)).toBe(false);
    });
  });

  describe('DEFAULT_DICE_MODE', () => {
    it('is digital, and is itself a valid dice mode', () => {
      expect(DEFAULT_DICE_MODE).toBe('digital');
      expect(isValidDiceMode(DEFAULT_DICE_MODE)).toBe(true);
    });
  });

  describe('areInitialCardsEqual', () => {
    it('is true for the same counts regardless of key order', () => {
      // JSON.stringify comparison (the pattern this helper replaces) is
      // key-order-sensitive and would call these two different.
      const reordered = Object.fromEntries(Object.entries(DEFAULT_INITIAL_CARDS).reverse());
      expect(areInitialCardsEqual(reordered, DEFAULT_INITIAL_CARDS)).toBe(true);
    });

    it('is false when any card count differs', () => {
      expect(areInitialCardsEqual({ ...DEFAULT_INITIAL_CARDS, Stop: 9 }, DEFAULT_INITIAL_CARDS)).toBe(false);
    });

    it('treats a missing entry as 0', () => {
      const withoutKleeblatt = { ...DEFAULT_INITIAL_CARDS };
      delete withoutKleeblatt.Kleeblatt;
      expect(areInitialCardsEqual(withoutKleeblatt, { ...DEFAULT_INITIAL_CARDS, Kleeblatt: 0 })).toBe(true);
      expect(areInitialCardsEqual(withoutKleeblatt, DEFAULT_INITIAL_CARDS)).toBe(false);
    });

    it('is true for two empty decks', () => {
      expect(areInitialCardsEqual({}, {})).toBe(true);
    });
  });

  describe('isNormalizedConfig', () => {
    const NORMALIZED = { winningScore: DEFAULT_WINNING_SCORE, initialCards: DEFAULT_INITIAL_CARDS };

    it('is true for the default winning score on the default deck', () => {
      expect(isNormalizedConfig(NORMALIZED)).toBe(true);
    });

    it('is false for any other winning score', () => {
      expect(isNormalizedConfig({ ...NORMALIZED, winningScore: MIN_WINNING_SCORE })).toBe(false);
      expect(isNormalizedConfig({ ...NORMALIZED, winningScore: MAX_WINNING_SCORE })).toBe(false);
      expect(isNormalizedConfig({ ...NORMALIZED, winningScore: DEFAULT_WINNING_SCORE + 1 })).toBe(false);
    });

    it('is false when any single card count deviates from the default deck', () => {
      for (const card of VALID_CARD_TYPES) {
        const tweaked = { ...DEFAULT_INITIAL_CARDS, [card]: (DEFAULT_INITIAL_CARDS[card] ?? 0) + 1 };
        expect(isNormalizedConfig({ ...NORMALIZED, initialCards: tweaked })).toBe(false);
      }
    });

    it('is false for a deck missing a card type the default deck has', () => {
      const withoutStop = { ...DEFAULT_INITIAL_CARDS };
      delete withoutStop.Stop;
      expect(isNormalizedConfig({ ...NORMALIZED, initialCards: withoutStop })).toBe(false);
    });

    it('is true for the default counts written in a different key order', () => {
      // Guards the same key-order trap areInitialCardsEqual exists for: a deck
      // serialized by another key order must not read as a custom game.
      const reordered = Object.fromEntries(Object.entries(DEFAULT_INITIAL_CARDS).reverse());
      expect(isNormalizedConfig({ ...NORMALIZED, initialCards: reordered })).toBe(true);
    });

    // The settings a game may change and still count. They are not even
    // fields of NormalizableConfig — these cases pin down that widening the
    // input never makes the predicate start reading them.
    it('ignores the turn timer, the kick timer, the play order and an enforced dice mode', () => {
      // Assigned to a variable rather than passed as a fresh literal: these
      // fields are deliberately NOT part of NormalizableConfig (see the
      // comment above), and the point of the test is that the predicate
      // ignores them on a real config object that carries them, same as
      // isNormalizedConfig's actual caller passes the whole GameStore config.
      const configWithExtraFields = {
        ...NORMALIZED,
        turnDuration: 0,
        reconnectTimeout: MAX_RECONNECT_TIMEOUT,
        randomOrder: false,
        enforcedDiceMode: 'physical',
      };
      expect(isNormalizedConfig(configWithExtraFields)).toBe(true);
    });

    // The ruleset selects which stats bucket PAIR a game lands in (modernized
    // vs classic) — it must never flip a game to "custom" by itself.
    it('ignores the ruleset', () => {
      const configWithRuleset = { ...NORMALIZED, ruleset: 'classic' };
      expect(isNormalizedConfig(configWithRuleset)).toBe(true);
    });
  });

  describe('isValidRuleset', () => {
    it('accepts exactly the two rule sets', () => {
      expect(isValidRuleset('modernized')).toBe(true);
      expect(isValidRuleset('classic')).toBe(true);
    });

    it('rejects junk, null and undefined (old saves without the field)', () => {
      expect(isValidRuleset('official')).toBe(false);
      expect(isValidRuleset('')).toBe(false);
      expect(isValidRuleset(null)).toBe(false);
      expect(isValidRuleset(undefined)).toBe(false);
      expect(isValidRuleset(1)).toBe(false);
    });

    it('accepts the default', () => {
      expect(isValidRuleset(DEFAULT_RULESET)).toBe(true);
    });
  });

  describe('normalizeRoomId', () => {
    it('upper-cases so "abc" and "ABC" resolve to the same room', () => {
      expect(normalizeRoomId('abc')).toBe('ABC');
      expect(normalizeRoomId('AbC')).toBe('ABC');
      expect(normalizeRoomId('ABC')).toBe('ABC');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeRoomId('  abc  ')).toBe('ABC');
      expect(normalizeRoomId('\tabc\n')).toBe('ABC');
    });

    it('trims before upper-casing, not after', () => {
      // Order only matters if trimming could ever change what upper-casing
      // does — it cannot for whitespace, but this pins the composition rather
      // than relying on that coincidence.
      expect(normalizeRoomId('  abc  ')).toBe('abc'.trim().toUpperCase());
    });

    it('is idempotent, so re-normalizing an already-canonical id is a no-op', () => {
      const canonical = normalizeRoomId('  abc  ');
      expect(normalizeRoomId(canonical)).toBe(canonical);
    });

    it('leaves a code that is only over length before trimming as fitting after', () => {
      const padded = `  ${'R'.repeat(MAX_ROOM_ID_LENGTH)}  `;
      expect(padded.length).toBeGreaterThan(MAX_ROOM_ID_LENGTH);
      expect(normalizeRoomId(padded)).toHaveLength(MAX_ROOM_ID_LENGTH);
    });
  });
});
