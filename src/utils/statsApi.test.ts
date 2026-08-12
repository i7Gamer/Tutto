/** @vitest-environment node */
import { describe, it, expect } from 'vitest';
import { deviceStatsRequest, DEVICE_ID_HEADER, DEVICE_STATS_PATH, gameModeOf } from './statsApi';
import { DEFAULT_INITIAL_CARDS, DEFAULT_WINNING_SCORE } from './configValidation';

// The device header a request for this id carries, as fetch would read it back.
const deviceHeaderFor = (deviceId: string): string => {
  const [, init] = deviceStatsRequest(deviceId);
  return (init.headers as Record<string, string>)[DEVICE_ID_HEADER];
};

describe('statsApi', () => {
  describe('deviceStatsRequest', () => {
    it('asks for the normalized bucket when no mode is named', () => {
      const [url] = deviceStatsRequest('dev-1');
      expect(url).toBe(`${DEVICE_STATS_PATH}?mode=normalized`);
      expect(deviceHeaderFor('dev-1')).toBe('dev-1');
    });

    it('asks for the custom bucket when told to', () => {
      const [url] = deviceStatsRequest('dev-1', 'custom');
      expect(url).toBe(`${DEVICE_STATS_PATH}?mode=custom`);
    });

    it('keeps the device id out of the URL entirely', () => {
      // The whole point of the header: a path segment is written into every
      // fronting proxy's access.log, and this id is what lets a client
      // reclaim its seat.
      const [url] = deviceStatsRequest('dev-1', 'custom');
      expect(url).not.toContain('dev-1');
    });

    it('escapes a device id rather than letting it shape the header', () => {
      // A stored id is not supposed to contain these, but it reaches this
      // request straight from localStorage.
      expect(deviceHeaderFor('a/b?mode=custom')).toBe('a%2Fb%3Fmode%3Dcustom');
    });

    it('escapes a newline so an id cannot smuggle a second header', () => {
      const smuggled = deviceHeaderFor('dev-1\r\nx-tutto-token: stolen');
      expect(smuggled).not.toMatch(/[\r\n]/);
      expect(smuggled).toBe('dev-1%0D%0Ax-tutto-token%3A%20stolen');
    });

    it('produces a header value fetch itself will accept', () => {
      // Headers is the same validator fetch runs: an illegal value throws
      // here, so the request would never leave the browser at all.
      const [, init] = deviceStatsRequest('dev\n1 ünïcode');
      expect(() => new Headers(init.headers)).not.toThrow();
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
