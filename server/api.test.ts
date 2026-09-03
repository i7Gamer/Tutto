/**
 * @vitest-environment node
 */
import type { ChildProcess } from 'child_process';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type express from 'express';
import { registerApiRoutes } from './api';
import { startTestServer } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';
import { DEVICE_ID_HEADER, DEVICE_STATS_PATH } from '../src/utils/statsApi';

// setupTests.tsx stashes the real fetch here before installing its jsdom-only
// stub; several describes below restore it explicitly rather than relying on
// @vitest-environment node (see the comment at each call site).
const restoreNativeFetch = (): void => {
  const nativeFetch = (globalThis as { __nativeFetch?: typeof fetch }).__nativeFetch;
  if (nativeFetch) globalThis.fetch = nativeFetch;
};

const ensureDistIndexHtml = () => {
  const distDir = path.join(__dirname, '../dist');
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(indexPath, '<!DOCTYPE html><html><body>SPA Fallback Test</body></html>');
  }
};
ensureDistIndexHtml();

// A stand-in for a real Vite output file — the content-hashed name is the
// only thing the immutable-caching test below cares about, since server/
// index.ts keys its long-lived Cache-Control off the /assets/ mount, not off
// anything in the file itself.
const DIST_ASSET_STUB_NAME = 'x.abc123.js';
const ensureDistAssetStub = () => {
  const assetsDir = path.join(__dirname, '../dist/assets');
  const assetPath = path.join(assetsDir, DIST_ASSET_STUB_NAME);
  if (!fs.existsSync(assetPath)) {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(assetPath, '// stub asset for the immutable-caching test\n');
  }
};
ensureDistAssetStub();

describe('API Endpoints Token Protection', () => {
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.apiTokenProtection;
  const API_TOKEN = 'tutto-local-dev-token';

  beforeAll(async () => {
    // No fetch restore needed: setupTests.tsx installs its stub only under
    // jsdom, so a node-environment suite like this one keeps the real fetch.

    // The crash-log tests below intentionally make the child log
    // '[client-error]' entries — expected noise, quieted; anything else is real.
    serverProcess = await startTestServer(PORT, {
      env: { API_TOKEN },
      quietStderr: ['[client-error]'],
    });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('GET /api/stats/global works without token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`);
    expect(res.status).toBe(200);
  });

  // The device id rides a header, never a path segment — see
  // deviceStatsRequest in src/utils/statsApi.ts for why. Escaped here exactly
  // as the client escapes it.
  const deviceStatsGet = (deviceId: string, query = ''): Promise<Response> =>
    fetch(`http://127.0.0.1:${PORT}/api/stats/device${query}`, {
      headers: { 'x-tutto-device': encodeURIComponent(deviceId) },
    });

  it('GET the device stats route works without a token', async () => {
    const res = await deviceStatsGet('test-dev');
    expect(res.status).toBe(200);
  });

  it('GET the device stats route forbids shared caching of a per-device answer', async () => {
    // Since the device id moved into a header, this URL is IDENTICAL for every
    // device — so the response is only ever distinguishable by that header. A
    // shared cache in front of /api with a positive TTL would serve one
    // device's stats to the next caller. Vary alone is not enough (Cloudflare
    // ignores Vary on most plans), so the response must simply not be stored.
    const res = await deviceStatsGet('test-dev-cache');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('GET the device stats route rejects a request carrying no device header', async () => {
    // No header, no id — the same rejection an unusable path param used to get.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/device`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid device id' });
  });

  it('GET the device stats route rejects an empty device header', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/device`, {
      headers: { 'x-tutto-device': '' },
    });
    expect(res.status).toBe(400);
  });

  it('no longer answers a device id spelled into the path', async () => {
    // The path segment was the leak: every fronting proxy writes it into
    // access.log, and this id is what lets a client reclaim its seat.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/test-dev`);
    expect(res.status).toBe(404);
  });

  it('POST /api/stats/global fails without token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/stats/:deviceId fails without token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/test-dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/stats/global fails with an incorrect token of the same length', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tutto-token': 'x'.repeat(API_TOKEN.length) },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/stats/global fails with a token of a different length', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tutto-token': API_TOKEN + 'extra' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(403);
  });

  it('POST /api/stats/global succeeds with token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tutto-token': API_TOKEN },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/stats/:deviceId succeeds with token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/test-dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tutto-token': API_TOKEN },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(200);
  });

  it('GET /api/health reports ok without a token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/health is not rate limited', async () => {
    // The container HEALTHCHECK polls this endpoint for the lifetime of the
    // process. Behind the stats limiter (60 requests/minute) a busy or
    // long-lived container would eventually be marked unhealthy and restarted.
    const requestCount = 70;
    const responses = await Promise.all(
      Array.from({ length: requestCount }, () => fetch(`http://127.0.0.1:${PORT}/api/health`)),
    );
    expect(responses.map(res => res.status)).toEqual(Array(requestCount).fill(200));
  });

  it('rejects an unmatched /api/* route with 404 instead of the SPA fallback', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('rejects an unmatched /api/* route for any HTTP method', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global/extra`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('still serves the SPA fallback for a non-API unmatched route', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('still serves the SPA fallback for a deeply nested client route', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/deep/nested/link`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('404s an asset-shaped path instead of serving the shell', async () => {
    // Not a real file under dist/, so express.static already missed it —
    // this is the fallback's own asset-shape check, not a redirect to a
    // stubbed file.
    const res = await fetch(`http://127.0.0.1:${PORT}/game/assets/app.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  it('404s a missing favicon.ico instead of serving the shell', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/favicon.ico`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  it('caches a hashed asset under /assets/ immutably for a year', async () => {
    // The hash is the URL's own guarantee of content — see ASSET_CACHE_MAX_AGE_MS
    // in server/index.ts.
    const res = await fetch(`http://127.0.0.1:${PORT}/assets/${DIST_ASSET_STUB_NAME}`);
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get('cache-control') ?? '';
    expect(cacheControl).toContain('immutable');
    expect(cacheControl).toContain('max-age=31536000');
  });

  it('still answers max-age: 0 for the index route', async () => {
    // index.html keeps the same URL across every deploy, so it must always
    // revalidate rather than inherit the assets' year-long cache.
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toContain('max-age=0');
  });

  it('GET the device stats route rejects an oversized device id with 400', async () => {
    // Same 200-char cap the socket path enforces in joinRoom, measured on the
    // decoded id rather than the escaping around it.
    const res = await deviceStatsGet('x'.repeat(201));
    expect(res.status).toBe(400);
  });

  it('GET the device stats route rejects a malformed escape in the device header with 400', async () => {
    // decodeURIComponent throws on this; express answers a path param with the
    // same escape a 400, so the header must not fall through as a 500.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/device`, {
      headers: { 'x-tutto-device': '%zz' },
    });
    expect(res.status).toBe(400);
  });

  it('reads back the id the header escapes, not the escaping', async () => {
    // The header is decoded before it reaches the database, so a row stays
    // keyed on the same raw id the socket path and the admin POST write.
    const deviceId = 'dev/odd id?x';
    const written = await fetch(`http://127.0.0.1:${PORT}/api/stats/${encodeURIComponent(deviceId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tutto-token': API_TOKEN },
      body: JSON.stringify({ gamesPlayed: 3 }),
    });
    expect(written.status).toBe(200);

    expect((await (await deviceStatsGet(deviceId)).json()).gamesPlayed).toBe(3);
  });

  it('POST /api/stats/:deviceId rejects an oversized device id with 400 even with a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/${'x'.repeat(201)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tutto-token': API_TOKEN },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
  });

  describe('the mode a stats request reads and writes', () => {
    const statsUrl = (deviceId: string, query = ''): string =>
      `http://127.0.0.1:${PORT}/api/stats/${deviceId}${query}`;

    const write = (deviceId: string, query: string, body: Record<string, number>): Promise<Response> =>
      fetch(statsUrl(deviceId, query), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tutto-token': API_TOKEN },
        body: JSON.stringify(body),
      });

    const read = async (deviceId: string, query = ''): Promise<Record<string, number>> =>
      (await deviceStatsGet(deviceId, query)).json();

    it('keeps the two modes apart end to end', async () => {
      const deviceId = 'api-mode-split';
      expect((await write(deviceId, '', { gamesPlayed: 2 })).status).toBe(200);
      expect((await write(deviceId, '?mode=custom', { gamesPlayed: 7 })).status).toBe(200);

      expect((await read(deviceId)).gamesPlayed).toBe(2);
      expect((await read(deviceId, '?mode=custom')).gamesPlayed).toBe(7);
    });

    it('falls back to the normalized row for a missing, empty or unrecognised mode', async () => {
      // Old clients send no mode at all, and an unknown value must not become
      // a third bucket nobody can ever read back.
      const deviceId = 'api-mode-fallback';
      await write(deviceId, '', { gamesPlayed: 1 });

      expect((await read(deviceId)).gamesPlayed).toBe(1);
      expect((await read(deviceId, '?mode=')).gamesPlayed).toBe(1);
      expect((await read(deviceId, '?mode=bogus')).gamesPlayed).toBe(1);
      expect((await read(deviceId, '?mode[]=custom')).gamesPlayed).toBe(1);
    });

    it('refuses to write an unrecognised mode anywhere at all', async () => {
      // A read can only answer an unknown bucket with the default one. A
      // write must not: `?mode=bogus` used to land in the normalized row —
      // the row a player reads as their real record — and answer
      // `success: true`, so a typo corrupted it invisibly.
      const deviceId = 'api-mode-write-fallback';
      const refused = await write(deviceId, '?mode=bogus', { gamesPlayed: 5 });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toContain('normalized');

      expect(await read(deviceId)).toEqual({});
      expect(await read(deviceId, '?mode=custom')).toEqual({});
    });
  });

  it('POST /api/log/client-error accepts crash reports without a token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/log/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'boom',
        stack: 'Error: boom\n  at DiceGame',
        componentStack: 'at DiceGame\nat Game',
        timestamp: new Date().toISOString(),
      })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('POST /api/log/client-error tolerates junk payloads without crashing', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/log/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { nested: 'object' }, stack: 12345, extra: 'x'.repeat(50000) })
    });
    expect(res.status).toBe(200);

    // The server must still be responsive afterwards.
    const alive = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`);
    expect(alive.status).toBe(200);
  });
});

describe('POST /api/log/client-error rate limiting', () => {
  let serverProcess: ChildProcess | undefined;
  // Was '3008', which server/socket.test.ts's 'Socket updateConfig' describe
  // block also hardcodes — two different test files spawning real server
  // subprocesses on the same port race for the bind whenever vitest runs
  // both files in parallel (its default), intermittently producing
  // "websocket error" client-side in whichever test loses the race. Every
  // PORT across server/*.test.ts must stay unique for the same reason.
  const PORT = TEST_PORTS.apiClientErrorRateLimit;

  beforeAll(async () => {
    restoreNativeFetch();

    serverProcess = await startTestServer(PORT, { quietStderr: ['[client-error]'] });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('starts rejecting with 429 once a client exceeds the per-window request cap', async () => {
    const post = () => fetch(`http://127.0.0.1:${PORT}/api/log/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'boom' }),
    });

    // The endpoint's own limit is 20/window; fire comfortably past that from
    // this single (shared, real-IP) test client so the cap is exceeded
    // regardless of exactly how many requests it allows.
    const responses = await Promise.all(Array.from({ length: 25 }, () => post()));
    const statuses = responses.map(r => r.status);

    expect(statuses.some(s => s === 200)).toBe(true);
    expect(statuses.some(s => s === 429)).toBe(true);
  }, 15000);
});

describe('CORS_ORIGIN configuration', () => {
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.apiCorsOrigin;
  const CORS_ORIGIN = 'https://tutto.example.com';

  beforeAll(async () => {
    restoreNativeFetch();

    serverProcess = await startTestServer(PORT, { env: { CORS_ORIGIN } });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('reflects the configured CORS_ORIGIN in Access-Control-Allow-Origin', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      headers: { Origin: CORS_ORIGIN },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(CORS_ORIGIN);
  });
});

// The scenario a freshly pulled Docker image runs in: NODE_ENV=production with
// no CORS_ORIGIN configured. This used to be a refusal to boot, which meant an
// unconfigured container crash-looped.
describe('production CORS defaults to same-origin', () => {
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.apiProductionCors;
  const FOREIGN_ORIGIN = 'https://evil.example';

  beforeAll(async () => {
    restoreNativeFetch();

    serverProcess = await startTestServer(PORT, {
      env: {
        NODE_ENV: 'production',
        API_TOKEN: 'a-strong-production-token',
        CORS_ORIGIN: '',
      },
    });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('boots in production without CORS_ORIGIN set', async () => {
    // Reaching this at all means the startup guard let the process live; the
    // beforeAll above only resolves on "Server running on port".
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    expect(res.status).toBe(200);
  });

  it('sends no Access-Control-Allow-Origin to a foreign origin', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      headers: { Origin: FOREIGN_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never answers a foreign origin with a wildcard', async () => {
    // The regression that matters: falling back to '*' here would let any site
    // make authenticated cross-origin requests against a deployed server.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      headers: { Origin: FOREIGN_ORIGIN },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('still serves same-origin requests normally', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ totalGamesPlayed: expect.any(Number) });
  });
});

// The SPA fallback's sendFile callback, driven directly rather than through a
// request: express reports an aborted request through it like any other error
// — the client hit stop or reload, or the connection dropped, while
// dist/index.html was streaming — and no real request can reproduce that on
// demand, since index.html leaves the server in a single write.
describe('the SPA fallback when sendFile reports an error', () => {
  // registerApiRoutes' last path-less app.use; the unmatched-/api 404 above it
  // is mounted on '/api'.
  const spaFallback = (): express.RequestHandler => {
    const pathless: express.RequestHandler[] = [];
    const app = {
      get: () => {},
      post: () => {},
      use: (...args: unknown[]) => {
        if (typeof args[0] === 'function') pathless.push(args[0] as express.RequestHandler);
      },
    } as unknown as express.Express;

    registerApiRoutes(app);
    return pathless[pathless.length - 1] as express.RequestHandler;
  };

  // What express hands the callback: an Error carrying the syscall code the
  // failure surfaced as.
  type SendFileError = Error & { code: string };

  const errorWithCode = (code: string): SendFileError => Object.assign(new Error(code), { code });

  // Navigation-shaped: no extension on the last segment, so these drive the
  // sendFile branch rather than the asset-shaped 404 short-circuit.
  const navigationRequest = { path: '/some/client/route' } as express.Request;

  // What the handler writes once sendFile hands it `error`, with the response
  // either already started or not.
  const responseTo = (error: SendFileError | undefined, headersSent: boolean) => {
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    const res = {
      headersSent,
      status,
      send,
      sendFile: (_file: string, _options: unknown, callback: (err?: SendFileError) => void): void => callback(error),
    } as unknown as express.Response;

    spaFallback()(navigationRequest, res, (() => {}) as express.NextFunction);
    return { status, send };
  };

  it('sends index.html relative to dist/ as its root, not by absolute path', () => {
    // sendFile's dotfiles policy defaults to "ignore", and without a `root`
    // it inspects EVERY segment of the absolute path — so a checkout under
    // any dot-directory (~/.apps/tutto, a .claude/worktrees probe) answered
    // 404 for every client route while express.static, which is rooted,
    // served the assets fine. Rooted at dist/, only "index.html" is judged.
    const sendFile = vi.fn();
    const res = { sendFile } as unknown as express.Response;

    spaFallback()(navigationRequest, res, (() => {}) as express.NextFunction);

    expect(sendFile).toHaveBeenCalledTimes(1);
    const [file, options] = sendFile.mock.calls[0] as [string, { root: string }];
    expect(file).toBe('index.html');
    expect(options.root).toBe(path.join(__dirname, '../dist'));
  });

  it('answers 404 without touching sendFile for an asset-shaped path', () => {
    // Reaching the fallback at all means express.static already failed to
    // find a real file there — so a request whose last segment looks like a
    // filename (a missing JS chunk, a probed favicon.ico) must not get the
    // HTML shell, which is what used to mask a 404 as a "successful" fetch.
    const sendFile = vi.fn();
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const res = { sendFile, status, json } as unknown as express.Response;

    spaFallback()(
      { path: '/game/assets/app.js' } as express.Request,
      res,
      (() => {}) as express.NextFunction,
    );

    expect(sendFile).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'Not found' });
  });

  it('writes nothing when the client aborts after the response has started', () => {
    // The headers are already on the wire, so answering anyway throws
    // ERR_HTTP_HEADERS_SENT out of this callback — uncaught, which takes the
    // whole server down over one client hitting reload.
    const { status, send } = responseTo(errorWithCode('ECONNABORTED'), true);

    expect(status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('writes nothing when the connection drops before the response starts', () => {
    // Nothing is throwing here, but there is also nobody left to answer: a 404
    // would misreport a perfectly present index.html.
    const { status, send } = responseTo(errorWithCode('ECONNRESET'), false);

    expect(status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('still answers 404 when dist/index.html is genuinely missing', () => {
    const { status, send } = responseTo(errorWithCode('ENOENT'), false);

    expect(status).toHaveBeenCalledWith(404);
    expect(send).toHaveBeenCalledWith('Not found');
  });

  it('adds nothing to a file that went out fine', () => {
    const { status, send } = responseTo(undefined, true);

    expect(status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('STATS_RATE_LIMIT_MAX overrides the stats per-window cap', () => {
  // The test harness raises this for spawned servers so a slow poll cannot
  // 429 the rest of its suite; the override is only real if api.ts reads it.
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.apiStatsRateLimitEnv;
  const TINY_CAP = '2';

  beforeAll(async () => {
    restoreNativeFetch();
    serverProcess = await startTestServer(PORT, { env: { STATS_RATE_LIMIT_MAX: TINY_CAP } });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('rejects the request after the overridden cap, not after the production 60', async () => {
    const get = () => fetch(`http://127.0.0.1:${PORT}/api/stats/global`);
    const statuses = [];
    for (let i = 0; i < Number(TINY_CAP) + 1; i++) statuses.push((await get()).status);

    expect(statuses.slice(0, Number(TINY_CAP))).toEqual([200, 200]);
    expect(statuses[Number(TINY_CAP)]).toBe(429);
  }, 15000);
});

describe('GET /api/stats/global rate limiting', () => {
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.apiGlobalStatsRateLimit;
  // vite.config.ts raises STATS_RATE_LIMIT_MAX for every spawned server so a
  // polling suite cannot 429 itself; this suite is about the production cap,
  // so it pins the default explicitly.
  const PRODUCTION_STATS_CAP = '60';

  beforeAll(async () => {
    restoreNativeFetch();

    serverProcess = await startTestServer(PORT, { env: { STATS_RATE_LIMIT_MAX: PRODUCTION_STATS_CAP } });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('starts rejecting with 429 once a client exceeds the stats per-window request cap', async () => {
    const get = () => fetch(`http://127.0.0.1:${PORT}/api/stats/global`);

    // The endpoint's limit is 60/window; fire 65 requests.
    const responses = await Promise.all(Array.from({ length: 65 }, () => get()));
    const statuses = responses.map(r => r.status);

    expect(statuses.some(s => s === 200)).toBe(true);
    expect(statuses.some(s => s === 429)).toBe(true);
  }, 15000);
});

// Regression coverage for the fix keying GET /api/stats/device by device id:
// before it, this route shared one IP-wide bucket with GET /api/stats/global,
// so several devices finishing behind the same NAT/proxy IP (the end-screen
// retry loop in useDeviceStats.ts fires several reads per finishing device)
// could exhaust it and 429 a device that never made a request of its own.
describe('GET /api/stats/device rate limiting is keyed per device', () => {
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.apiDeviceStatsRateLimit;
  const TINY_CAP = '2';

  beforeAll(async () => {
    restoreNativeFetch();
    serverProcess = await startTestServer(PORT, { env: { STATS_RATE_LIMIT_MAX: TINY_CAP } });
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  const getDevice = (deviceId: string) => fetch(`http://127.0.0.1:${PORT}${DEVICE_STATS_PATH}`, {
    headers: { [DEVICE_ID_HEADER]: encodeURIComponent(deviceId) },
  });

  it('does not 429 device B once device A alone has exhausted the cap, though both share this IP', async () => {
    const capExceedingRequestCount = Number(TINY_CAP) + 1;
    const deviceAStatuses: number[] = [];
    for (let i = 0; i < capExceedingRequestCount; i++) deviceAStatuses.push((await getDevice('device-a')).status);

    // Device A alone blew through its own bucket.
    expect(deviceAStatuses.slice(0, Number(TINY_CAP))).toEqual([200, 200]);
    expect(deviceAStatuses[Number(TINY_CAP)]).toBe(429);

    // Device B, same IP, gets its own bucket — untouched by A's requests.
    const deviceBRes = await getDevice('device-b');
    expect(deviceBRes.status).toBe(200);
  }, 15000);

  it('still rate-limits by IP a caller with no device header at all', async () => {
    const capExceedingRequestCount = Number(TINY_CAP) + 1;
    const get = () => fetch(`http://127.0.0.1:${PORT}${DEVICE_STATS_PATH}`);
    const statuses: number[] = [];
    for (let i = 0; i < capExceedingRequestCount; i++) statuses.push((await get()).status);

    // Every request here is missing the device header, so the route answers
    // 400 for each one it doesn't rate-limit away first — but once the
    // shared IP bucket is exhausted, the rate limiter runs before that
    // validation and answers 429 instead.
    expect(statuses.slice(0, Number(TINY_CAP))).toEqual([400, 400]);
    expect(statuses[Number(TINY_CAP)]).toBe(429);
  }, 15000);
});
