import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CRASH_LOG_KEY,
  buildCrashEntry,
  readCrashLog,
  recordCrash,
  warnAboutRecentCrash,
} from './crashLog';

describe('crashLog', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe('buildCrashEntry', () => {
    it('extracts message and stack from an Error', () => {
      const entry = buildCrashEntry(new Error('boom'), 'at DiceGame');
      expect(entry.message).toBe('boom');
      expect(entry.stack).toContain('boom');
      expect(entry.componentStack).toBe('at DiceGame');
      expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
    });

    it('stringifies non-Error values and tolerates missing componentStack', () => {
      const entry = buildCrashEntry('a string was thrown');
      expect(entry.message).toBe('a string was thrown');
      expect(entry.stack).toBe('');
      expect(entry.componentStack).toBe('');
    });

    it('truncates oversized fields to 2000 characters', () => {
      const entry = buildCrashEntry(new Error('x'.repeat(5000)), 'y'.repeat(5000));
      expect(entry.message.length).toBe(2000);
      expect(entry.componentStack.length).toBe(2000);
    });
  });

  describe('readCrashLog', () => {
    it('returns an empty array when nothing is stored', () => {
      expect(readCrashLog()).toEqual([]);
    });

    it('returns an empty array for corrupted JSON', () => {
      localStorage.setItem(CRASH_LOG_KEY, 'not json {]');
      expect(readCrashLog()).toEqual([]);
    });

    it('returns an empty array when the stored value is not an array', () => {
      localStorage.setItem(CRASH_LOG_KEY, JSON.stringify({ message: 'boom' }));
      expect(readCrashLog()).toEqual([]);
    });
  });

  describe('recordCrash', () => {
    it('appends the crash to localStorage and POSTs it to the server', () => {
      recordCrash(new Error('boom'), 'at Game');

      const log = readCrashLog();
      expect(log).toHaveLength(1);
      expect(log[0].message).toBe('boom');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, { method: string; keepalive: boolean; body: string }];
      expect(url).toBe('/api/log/client-error');
      expect(options.method).toBe('POST');
      expect(options.keepalive).toBe(true);
      expect(JSON.parse(options.body as string).message).toBe('boom');
    });

    it('keeps only the 5 most recent entries', () => {
      for (let i = 1; i <= 7; i++) {
        recordCrash(new Error(`crash ${i}`));
      }
      const log = readCrashLog();
      expect(log).toHaveLength(5);
      expect(log[0].message).toBe('crash 3');
      expect(log[4].message).toBe('crash 7');
    });

    it('still writes localStorage when the fetch rejects', () => {
      fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
      expect(() => recordCrash(new Error('boom'))).not.toThrow();
      expect(readCrashLog()).toHaveLength(1);
    });

    it('still writes localStorage when fetch throws synchronously', () => {
      fetchMock.mockImplementation(() => { throw new Error('no fetch'); });
      expect(() => recordCrash(new Error('boom'))).not.toThrow();
      expect(readCrashLog()).toHaveLength(1);
    });

    it('still POSTs when localStorage writes fail (quota exceeded)', () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      expect(() => recordCrash(new Error('boom'))).not.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      setItemSpy.mockRestore();
    });
  });

  describe('warnAboutRecentCrash', () => {
    it('warns with the most recent stored crash', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      recordCrash(new Error('older'));
      recordCrash(new Error('newest'));

      warnAboutRecentCrash();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('newest');
      expect(warnSpy.mock.calls[0][0]).toContain('2 stored crash report(s)');
    });

    it('stays silent when no crash is stored', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warnAboutRecentCrash();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not throw or print "undefined" when a stored entry is missing expected fields (ENGINE-SMELL-8)', () => {
      // readCrashLog only validates that the parsed JSON is an array — an
      // older-format or hand-edited entry can be missing message/timestamp entirely.
      localStorage.setItem(CRASH_LOG_KEY, JSON.stringify([{ stack: 'x' }]));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => warnAboutRecentCrash()).not.toThrow();

      expect(warnSpy.mock.calls[0][0]).toContain('(unknown time)');
      expect(warnSpy.mock.calls[0][0]).toContain('(unknown)');
    });
  });
});
