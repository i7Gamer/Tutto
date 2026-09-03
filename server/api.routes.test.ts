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
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import type http from 'http';
import { registerApiRoutes, DEFAULT_STATS_RATE_LIMIT_MAX } from './api';
import { envLimitOr } from './envLimits';
import { getDeviceStats, updateDeviceStats, getGlobalStats, updateGlobalStats } from './database';
import { DEVICE_ID_HEADER, DEVICE_STATS_PATH } from '../src/utils/statsApi';
import { DEFAULT_GAME_MODE, type GlobalStatsRow } from '../src/types';
import { DEFAULT_RULESET } from '../src/utils/configValidation';
import { makeDeviceStatsRow } from '../src/testing/factories';

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

// Full rows, every field zeroed, so the two `mockResolvedValueOnce` call sites
// below stay real DeviceStatsRow/GlobalStatsRow values (the handler does
// `res.json(stats ?? {})` — a straight pass-through of whatever the database
// layer resolves) instead of a `Record<string, number>` standing in for one.
// The device-row factory lives in src/testing/factories.ts as
// makeDeviceStatsRow, shared with server/socketStatsHandlers.test.ts.
const deviceRow = makeDeviceStatsRow;

const globalRow = (overrides: Partial<GlobalStatsRow> = {}): GlobalStatsRow => ({
  ruleset: DEFAULT_RULESET,
  totalGamesPlayed: 0,
  totalPlaytime: 0,
  totalPlusMinus: 0,
  totalKniffel: 0,
  totalStop: 0,
  totalFeuerwerk: 0,
  totalKleeblatt: 0,
  totalKleeblattCompleted: 0,
  totalx2: 0,
  totalTurns: 0,
  totalScore: 0,
  totalPlusMinusCompleted: 0,
  totalKniffelCompleted: 0,
  totalFeuerwerkPoints: 0,
  totalx2Points: 0,
  defaultGamesPlayed: 0,
  customGamesPlayed: 0,
  totalFeuerwerkBusts: 0,
  totalx2Busts: 0,
  totalBusts: 0,
  highestTurnScore: null,
  fastestWinTurns: null,
  fastestLossTurns: null,
  mostPlayersInGame: null,
  totalPlayersSum: 0,
  longestGameRounds: null,
  totalRoundsSum: 0,
  highestFeuerwerkTurnScore: null,
  highestX2TurnScore: null,
  totalTuttos: 0,
  mostCardsInTurn: null,
  highestForfeitedTurnScore: null,
  ...overrides,
});

/**
 * The handler registerApiRoutes mounts for one exact GET path, captured off a
 * stub app.
 *
 * The real app below answers over HTTP, which is the right level for anything
 * a client can observe — but sendFile's OPTIONS are not one of those things (a
 * wrong `root` and a missing file both surface as the same plain 404), so the
 * one assertion that needs them drives the handler directly instead.
 */
const registeredGetHandler = (routePath: string): express.RequestHandler => {
  let found: express.RequestHandler | undefined;
  const app = {
    get: (mountedAt: unknown, ...handlers: unknown[]) => {
      // The last argument, so a route mounted behind a rate limiter still
      // yields its own handler rather than the middleware in front of it.
      if (mountedAt === routePath) found = handlers[handlers.length - 1] as express.RequestHandler;
    },
    post: () => {},
    use: () => {},
  } as unknown as express.Express;

  registerApiRoutes(app);
  if (!found) throw new Error(`registerApiRoutes mounts no GET ${routePath}`);
  return found;
};

describe('api routes in-process', () => {
  let server: http.Server;
  let port: number;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let previousApiToken: string | undefined;

  beforeAll(async () => {
    // No fetch restore needed: setupTests.tsx installs its stub only under
    // jsdom, so a node-environment suite like this one keeps the real fetch.
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
      const row = globalRow({ totalGamesPlayed: 10 });
      vi.mocked(getGlobalStats).mockResolvedValueOnce(row);
      const res = await fetch(url('/api/stats/global'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(row);
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

    // A READ that names a row which does not exist can only answer with the
    // default one. A WRITE cannot: the numbers land somewhere permanent, and
    // silently putting them in the modernized row while answering
    // `success: true` is how a typo'd admin call corrupts the row it never
    // meant to touch.
    it('refuses a mistyped ruleset instead of writing the default row', async () => {
      const res = await postJson('/api/stats/global?ruleset=modernised', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error, 'the answer names what would have worked').toContain('modernized');
      expect(body.error).toContain('classic');
      expect(updateGlobalStats).not.toHaveBeenCalled();
    });

    it('refuses a ruleset parameter left empty', async () => {
      const res = await postJson('/api/stats/global?ruleset=', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(400);
      expect(updateGlobalStats).not.toHaveBeenCalled();
    });

    it('still writes the default row when no ruleset is named at all', async () => {
      const res = await postJson('/api/stats/global', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(200);
      expect(updateGlobalStats).toHaveBeenCalledWith({ gamesPlayed: 1 }, DEFAULT_RULESET);
    });

    it('answers a bad token before it ever looks at the ruleset', async () => {
      const res = await postJson('/api/stats/global?ruleset=modernised', { gamesPlayed: 1 }, 'wrong-token');
      expect(res.status).toBe(403);
    });

    // This route reads `ruleset`, not `mode` — but 'classic' is a member of
    // both GAME_MODES and RULESETS, so `?mode=classic` on this route is the
    // plausible operator typo (meant ?ruleset=classic) that silently wrote
    // the default ruleset row while `mode` was quietly ignored.
    it('refuses a mode= parameter — this route accepts ruleset, not mode', async () => {
      const res = await postJson('/api/stats/global?mode=classic', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('ruleset');
      expect(updateGlobalStats).not.toHaveBeenCalled();
    });

    it('still writes when the correct ruleset parameter is used alongside no mode', async () => {
      const res = await postJson('/api/stats/global?ruleset=classic', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(200);
      expect(updateGlobalStats).toHaveBeenCalledWith({ gamesPlayed: 1 }, 'classic');
    });
  });

  describe('GET the device stats route', () => {
    it('decodes the header id and reads the requested mode', async () => {
      const row = deviceRow({ gamesPlayed: 5 });
      vi.mocked(getDeviceStats).mockResolvedValueOnce(row);
      const res = await getDevice('dev/odd id?x', '?mode=custom');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(row);
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

    it('refuses a mistyped mode instead of writing the default bucket', async () => {
      const res = await postJson('/api/stats/in-proc-device?mode=nomral', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error, 'the answer names what would have worked').toContain('normalized');
      expect(body.error).toContain('classic_custom');
      expect(updateDeviceStats).not.toHaveBeenCalled();
    });

    it('refuses a mode parameter left empty', async () => {
      const res = await postJson('/api/stats/in-proc-device?mode=', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(400);
      expect(updateDeviceStats).not.toHaveBeenCalled();
    });

    it('still writes the default bucket when no mode is named at all', async () => {
      const res = await postJson('/api/stats/in-proc-device', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(200);
      expect(updateDeviceStats).toHaveBeenCalledWith('in-proc-device', { gamesPlayed: 1 }, DEFAULT_GAME_MODE);
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

    // This route reads `mode`, not `ruleset` — but 'classic' is a member of
    // both GAME_MODES and RULESETS, so `?ruleset=classic` on this route is
    // the plausible operator typo (meant ?mode=classic) that silently wrote
    // the default mode bucket while `ruleset` was quietly ignored.
    it('refuses a ruleset= parameter — this route accepts mode, not ruleset', async () => {
      const res = await postJson('/api/stats/in-proc-device?ruleset=classic', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('mode');
      expect(updateDeviceStats).not.toHaveBeenCalled();
    });

    it('still writes when the correct mode parameter is used alongside no ruleset', async () => {
      const res = await postJson('/api/stats/in-proc-device?mode=classic', { gamesPlayed: 1 }, API_TOKEN);
      expect(res.status).toBe(200);
      expect(updateDeviceStats).toHaveBeenCalledWith('in-proc-device', { gamesPlayed: 1 }, 'classic');
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

  /**
   * AGPL-3.0 §13: the licence and the attribution have to be reachable from
   * the running app, not just present in the image. Both routes shipped with
   * no test of any kind — neither that they answer at all, nor that they
   * answer with the real file.
   */
  describe('the AGPL licence and attribution routes', () => {
    // api.ts serves them from path.join(__dirname, '..'), which is this
    // directory's parent — the repo root, where both files live.
    const REPO_ROOT = path.join(__dirname, '..');
    const LEGAL_FILES = ['COPYING', 'NOTICE'];

    it.each(LEGAL_FILES)('serves the real %s from the repo root', async (name) => {
      const res = await fetch(url(`/${name}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(fs.readFileSync(path.join(REPO_ROOT, name), 'utf8'));
    });

    it.each(LEGAL_FILES)('answers %s as text a browser displays, not a download', async (name) => {
      // Neither name has an extension, so send's own type sniffing gives up
      // and falls back to application/octet-stream — which browsers offer as
      // a file download. The whole point of an AGPL source/licence link is
      // that a visitor can READ it where they clicked it.
      const res = await fetch(url(`/${name}`));
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    });

    it.each(LEGAL_FILES)('serves %s by name under a root, never by absolute path', (name) => {
      // Invisible over HTTP — a wrong root just 404s, exactly as a missing
      // file does — so it is asserted on the sendFile call itself. sendFile's
      // dotfiles policy defaults to "ignore" and judges EVERY segment of an
      // un-rooted path, so a checkout under any dot-directory (~/.apps/tutto,
      // a .claude/worktrees probe) would 404 both files.
      const sendFile = vi.fn();
      registeredGetHandler(`/${name}`)(
        {} as express.Request,
        { set: vi.fn(), sendFile } as unknown as express.Response,
        (() => {}) as express.NextFunction,
      );

      expect(sendFile).toHaveBeenCalledWith(name, { root: REPO_ROOT }, expect.any(Function));
    });

    it.each(LEGAL_FILES)('does not serve %s under a name it does not have', async (name) => {
      // The routes are exact names, not a prefix: anything else is a probe,
      // and one carrying an extension is asset-shaped, so it gets the SPA
      // fallback's 404 rather than a licence body under the wrong URL.
      const res = await fetch(url(`/${name}.txt`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
  });

  /**
   * What a request that fails BEFORE any route runs gets told.
   *
   * express.json() (mounted here exactly as index.ts mounts it) throws on a
   * malformed body, and with no error-handling middleware of its own the app
   * fell through to express 5's finalhandler — which answers with `err.stack`
   * whenever NODE_ENV !== 'production'. A single unauthenticated POST carrying
   * `{` therefore handed back absolute server paths and the body-parser call
   * chain, on the one route that exists for players with no credentials at all.
   */
  describe('a request that fails before any route runs', () => {
    // express.json()'s default body limit is 100kb; comfortably past it.
    const OVER_JSON_BODY_LIMIT_BYTES = 200_000;

    const postRaw = (body: string): Promise<Response> =>
      fetch(url('/api/log/client-error'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

    it('answers a malformed body with generic JSON, not a stack trace', async () => {
      const res = await postRaw('{');
      const text = await res.text();

      expect(res.headers.get('content-type')).toContain('application/json');
      expect(JSON.parse(text)).toEqual({ error: 'Bad request' });
      // The three things finalhandler used to leak: the exception's class, the
      // absolute paths of the modules it walked through, and their line
      // numbers. None of them tells an unauthenticated caller anything it is
      // entitled to know.
      expect(text).not.toContain('SyntaxError');
      expect(text).not.toContain('node_modules');
      expect(text).not.toMatch(/\.js:\d+/);
    });

    it('keeps body-parser own status rather than turning it into a 500', async () => {
      // The failure is the caller's, and saying so is the difference between
      // "fix your request" and "the server is broken". A blanket 500 would
      // also have made this indistinguishable from a database outage.
      expect((await postRaw('{')).status).toBe(400);
      expect((await postRaw(`"${'x'.repeat(OVER_JSON_BODY_LIMIT_BYTES)}"`)).status).toBe(413);
    });

    it('still records the real error server-side', async () => {
      // The client is told nothing useful on purpose, so the detail has to go
      // somewhere — silently swallowing it would make a genuine 500 invisible.
      await postRaw('{');
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});

// Item 5: the STATS_RATE_LIMIT_MAX production default (60) used to be a bare
// literal that nothing pinned — the rate-limit e2e in api.test.ts passes
// STATS_RATE_LIMIT_MAX explicitly for every server it spawns (a hardcoded
// '60' of its own), so it never exercises the fallback that runs in an actual
// unconfigured production deployment. Exporting the constant lets an
// in-process test assert on the real value directly.
describe('DEFAULT_STATS_RATE_LIMIT_MAX', () => {
  it('is the documented production default of 60', () => {
    expect(DEFAULT_STATS_RATE_LIMIT_MAX).toBe(60);
  });

  it('is what envLimitOr falls back to when STATS_RATE_LIMIT_MAX is unset', () => {
    expect(envLimitOr(undefined, DEFAULT_STATS_RATE_LIMIT_MAX)).toBe(60);
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
