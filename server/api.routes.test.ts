/** @vitest-environment node */
/**
 * In-process complement to api.test.ts. That file exercises the API through a
 * spawned server subprocess, which keeps its assertions honest end-to-end but
 * leaves V8 coverage blind: the handlers run in the child, so api.ts read as
 * ~37% covered while being tested rather thoroughly. This file mounts
 * registerApiRoutes on a plain express app in this process — the same
 * express.json() wiring index.ts uses — so the handler branches count, and it
 * drives the paths a healthy child process cannot produce on demand:
 *
 *  - the database layer failing (the 500 answers),
 *  - a device/global row that does not exist yet (the `?? {}` answers),
 *  - a crash report whose JSON body is not an object,
 *  - the production startup guard refusing to register at all.
 *
 * Only ./database is mocked. Sanitization, rate limiters and the token
 * comparison are the real code.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type http from 'http';
import { registerApiRoutes } from './api';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { DEVICE_ID_HEADER, DEVICE_STATS_PATH } from '../src/utils/statsApi';
import { DEFAULT_GAME_MODE } from '../src/types';
import { DEFAULT_RULESET } from '../src/utils/configValidation';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
  updateDeviceStats: vi.fn(),
  getGlobalStats: vi.fn(),
  updateGlobalStats: vi.fn(),
}));

// api.ts keeps these private; the tests state them once so a drift in either
// value fails loudly instead of silently weakening an assertion.
const TOKEN_HEADER = 'x-tutto-token'; // mirrors requireToken in api.ts
const DEVICE_ID_LENGTH_CAP = 200; // mirrors MAX_DEVICE_ID_LENGTH in api.ts
const CRASH_FIELD_CAP = 2000; // mirrors CRASH_FIELD_MAX in api.ts

const API_TOKEN = 'in-process-route-token';

const deviceRow = (stats: Record<string, number>) =>
  stats as Awaited<ReturnType<typeof getDeviceStats>>;
const globalRow = (stats: Record<string, number>) =>
  stats as Awaited<ReturnType<typeof getGlobalStats>>;

describe('api routes in-process', () => {
  let server: http.Server;
  let port: number;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let previousApiToken: string | undefined;

  beforeAll(async () => {
    // setupTests.tsx swaps global fetch for a jsdom stub; a node-environment
    // suite talking to a real socket needs the native one back.
    const stashed = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch;
    if (stashed) globalThis.fetch = stashed;

    previousApiToken = process.env.API_TOKEN;
    process.env.API_TOKEN = API_TOKEN;

    const app = express();
    app.use(express.json());
    registerApiRoutes(app);
    await new Promise<void>(resolve => {
      server = app.listen(0, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (previousApiToken === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = previousApiToken;
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Silences the intentional DB-failure logs and lets the crash-log tests
    // read what would have reached the server log.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  const url = (p: string): string => `http://127.0.0.1:${port}${p}`;

  const getDevice = (deviceId: string, query = ''): Promise<Response> =>
    fetch(url(`${DEVICE_STATS_PATH}${query}`), {
      headers: { [DEVICE_ID_HEADER]: encodeURIComponent(deviceId) },
    });

  const postJson = (p: string, body: unknown, token?: string): Promise<Response> =>
    fetch(url(p), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { [TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify(body),
    });

  describe('GET /api/stats/global', () => {
    it('answers the row the database returns', async () => {
      vi.mocked(getGlobalStats).mockResolvedValueOnce(globalRow({ totalGamesPlayed: 10 }));
      const res = await fetch(url('/api/stats/global'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ totalGamesPlayed: 10 });
      expect(getGlobalStats).toHaveBeenCalledWith(DEFAULT_RULESET);
    });

    it('answers {} when no row exists yet', async () => {
      vi.mocked(getGlobalStats).mockResolvedValueOnce(null);
      const res = await fetch(url('/api/stats/global'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    });

    it('passes a recognised ruleset through and falls back on anything else', async () => {
      vi.mocked(getGlobalStats).mockResolvedValue(null);
      await fetch(url('/api/stats/global?ruleset=classic'));
      expect(getGlobalStats).toHaveBeenLastCalledWith('classic');
      await fetch(url('/api/stats/global?ruleset=bogus'));
      expect(getGlobalStats).toHaveBeenLastCalledWith(DEFAULT_RULESET);
    });

    it('answers 500 when the database read fails', async () => {
      vi.mocked(getGlobalStats).mockRejectedValueOnce(new Error('disk gone'));
      const res = await fetch(url('/api/stats/global'));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Database error' });
    });
  });

  describe('POST /api/stats/global', () => {
    it('sanitizes the payload and writes the requested ruleset row', async () => {
      const res = await postJson('/api/stats/global?ruleset=classic', { gamesPlayed: 3, nonsense: 'x' }, API_TOKEN);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      // 'nonsense' coerces to NaN and is dropped by sanitizeStats — what
      // reaches the database is only the clean numeric field.
      expect(updateGlobalStats).toHaveBeenCalledWith({ gamesPlayed: 3 }, 'classic');
    });

    it('rejects a missing, wrong same-length, and wrong-length token alike', async () => {
      for (const token of [undefined, 'x'.repeat(API_TOKEN.length), `${API_TOKEN}-extra`]) {
        const res = await postJson('/api/stats/global', {}, token);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Forbidden' });
      }
      expect(updateGlobalStats).not.toHaveBeenCalled();
    });

    it('answers 500 when the database write fails', async () => {
      vi.mocked(updateGlobalStats).mockRejectedValueOnce(new Error('disk gone'));
      const res = await postJson('/api/stats/global', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Database error' });
    });
  });

  describe('GET the device stats route', () => {
    it('decodes the header id and reads the requested mode', async () => {
      vi.mocked(getDeviceStats).mockResolvedValueOnce(deviceRow({ gamesPlayed: 5 }));
      const res = await getDevice('dev/odd id?x', '?mode=custom');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ gamesPlayed: 5 });
      expect(getDeviceStats).toHaveBeenCalledWith('dev/odd id?x', 'custom');
    });

    it('falls back to the default mode for a missing or unrecognised one', async () => {
      vi.mocked(getDeviceStats).mockResolvedValue(null);
      await getDevice('fallback-dev');
      expect(getDeviceStats).toHaveBeenLastCalledWith('fallback-dev', DEFAULT_GAME_MODE);
      await getDevice('fallback-dev', '?mode=bogus');
      expect(getDeviceStats).toHaveBeenLastCalledWith('fallback-dev', DEFAULT_GAME_MODE);
      // The simple query parser reads mode[]= as the key 'mode[]', so a
      // repeated/array parameter never matches a real mode either.
      await getDevice('fallback-dev', '?mode[]=custom');
      expect(getDeviceStats).toHaveBeenLastCalledWith('fallback-dev', DEFAULT_GAME_MODE);
    });

    it('answers {} for a device that has no row yet, and never lets it be cached', async () => {
      vi.mocked(getDeviceStats).mockResolvedValueOnce(null);
      const res = await getDevice('new-dev');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    });

    it('accepts an id exactly at the length cap and rejects one past it', async () => {
      vi.mocked(getDeviceStats).mockResolvedValueOnce(null);
      expect((await getDevice('x'.repeat(DEVICE_ID_LENGTH_CAP))).status).toBe(200);
      expect((await getDevice('x'.repeat(DEVICE_ID_LENGTH_CAP + 1))).status).toBe(400);
    });

    it('rejects a request carrying no device header at all', async () => {
      const res = await fetch(url(DEVICE_STATS_PATH));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid device id' });
      expect(getDeviceStats).not.toHaveBeenCalled();
    });

    it('rejects a malformed percent-escape in the header with 400, not 500', async () => {
      const res = await fetch(url(DEVICE_STATS_PATH), {
        headers: { [DEVICE_ID_HEADER]: '%zz' },
      });
      expect(res.status).toBe(400);
      expect(getDeviceStats).not.toHaveBeenCalled();
    });

    it('answers 500 when the database read fails', async () => {
      vi.mocked(getDeviceStats).mockRejectedValueOnce(new Error('disk gone'));
      const res = await getDevice('unlucky-dev');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Database error' });
    });
  });

  describe('POST /api/stats/:deviceId', () => {
    it('sanitizes the payload and writes the requested mode', async () => {
      // A numeric string is a legitimate stat (sanitizeStats coerces it);
      // asserting on the coerced value proves the handler passes the
      // sanitized object through, not the raw body.
      const res = await postJson('/api/stats/in-proc-device?mode=custom', { gamesPlayed: '7' }, API_TOKEN);
      expect(res.status).toBe(200);
      expect(updateDeviceStats).toHaveBeenCalledWith('in-proc-device', { gamesPlayed: 7 }, 'custom');
    });

    it('rejects an oversized id with 400 even when the token is valid', async () => {
      const res = await postJson(`/api/stats/${'x'.repeat(DEVICE_ID_LENGTH_CAP + 1)}`, {}, API_TOKEN);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid device id' });
      expect(updateDeviceStats).not.toHaveBeenCalled();
    });

    it('answers 500 when the database write fails', async () => {
      vi.mocked(updateDeviceStats).mockRejectedValueOnce(new Error('disk gone'));
      const res = await postJson('/api/stats/unlucky-device', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Database error' });
    });
  });

  describe('POST /api/log/client-error', () => {
    it('flattens header fields and indents continuation lines before logging', async () => {
      const res = await postJson('/api/log/client-error', {
        timestamp: '2026-08-16T00:00:00.000Z',
        message: 'boom\n[client-error] forged entry',
        stack: 'Error: boom\nat DiceGame',
        componentStack: 'at DiceGame\nat Game',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      const entry = errorSpy.mock.calls.at(-1)?.[0] as string;
      // The embedded newline may not survive into the header line, or the
      // report could forge a standalone "[client-error]" entry.
      expect(entry.startsWith('[client-error] 2026-08-16T00:00:00.000Z boom [client-error] forged entry')).toBe(true);
      expect(entry).toContain('stack: Error: boom\n    at DiceGame');
      expect(entry).toContain('componentStack: at DiceGame\n    at Game');
    });

    it('truncates each field at the cap', async () => {
      await postJson('/api/log/client-error', { message: 'y'.repeat(CRASH_FIELD_CAP * 2) });
      const entry = errorSpy.mock.calls.at(-1)?.[0] as string;
      expect(entry).toContain('y'.repeat(CRASH_FIELD_CAP));
      expect(entry).not.toContain('y'.repeat(CRASH_FIELD_CAP + 1));
    });

    it('stamps its own timestamp when the report carries none', async () => {
      await postJson('/api/log/client-error', { message: 'no-timestamp' });
      const entry = errorSpy.mock.calls.at(-1)?.[0] as string;
      // An ISO-8601 stamp where the report's own would have gone.
      expect(entry).toMatch(/^\[client-error\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z no-timestamp\n/);
    });

    it('accepts a request whose body never parsed into an object', async () => {
      // No Content-Type, no body: express.json() leaves req.body unset, which
      // must read as an empty report, not a crash.
      const res = await fetch(url('/api/log/client-error'), { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });
  });

  describe('the routes around the stats API', () => {
    it('GET /api/health answers ok', async () => {
      const res = await fetch(url('/api/health'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('answers 404 for an unmatched /api path', async () => {
      const res = await fetch(url('/api/does-not-exist'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  });
});

describe('the production startup guard', () => {
  it('refuses to register routes when API_TOKEN is missing in production', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      // Surfacing the exit as a throw keeps the test process alive while
      // proving registerApiRoutes went down the refusal path.
      throw new Error('process.exit');
    });
    const previousNodeEnv = process.env.NODE_ENV;
    const previousToken = process.env.API_TOKEN;
    process.env.NODE_ENV = 'production';
    delete process.env.API_TOKEN;

    try {
      expect(() => registerApiRoutes(express())).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('API_TOKEN'));
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousToken === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = previousToken;
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
