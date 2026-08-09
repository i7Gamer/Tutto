/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { deviceStatsUrl, gameModeOf } from './statsApi';
import { DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE } from './configValidation';

describe('statsApi', () => {
  describe('deviceStatsUrl', () => {
    it('asks for the normalized bucket when no mode is named', () => {
      expect(deviceStatsUrl('dev-1')).toBe('/api/stats/dev-1?mode=normalized');
    });

    it('asks for the custom bucket when told to', () => {
      expect(deviceStatsUrl('dev-1', 'custom')).toBe('/api/stats/dev-1?mode=custom');
    });

    it('escapes a device id rather than letting it shape the URL', () => {
      // A stored id is not supposed to contain these, but it reaches this
      // string straight from localStorage — a stray '?' or '/' must not be
      // able to add a query parameter or change which route is hit.
      expect(deviceStatsUrl('a/b?mode=custom')).toBe('/api/stats/a%2Fb%3Fmode%3Dcustom?mode=normalized');
    });
  });

  describe('gameModeOf', () => {
    const NORMALIZED = { winningScore: DEFAULT_WINNING_SCORE, initialCards: DEFAULT_INITIAL_CARDS };

    it('names the default config normalized', () => {
      expect(gameModeOf(NORMALIZED)).toBe('normalized');
    });

    it('names a changed winning score custom', () => {
      expect(gameModeOf({ ...NORMALIZED, winningScore: 1000 })).toBe('custom');
    });

    it('names a changed deck custom', () => {
      expect(gameModeOf({ ...NORMALIZED, initialCards: { ...DEFAULT_INITIAL_CARDS, Stop: 1 } })).toBe('custom');
    });
  });
});
