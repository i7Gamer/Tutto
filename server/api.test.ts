/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { TEST_PORTS } from './testPorts';

const ensureDistIndexHtml = () => {
  const distDir = path.join(__dirname, '../dist');
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(indexPath, '<!DOCTYPE html><html><body>SPA Fallback Test</body></html>');
  }
};
ensureDistIndexHtml();

describe('API Endpoints Token Protection', () => {
  let serverProcess;
  const PORT = TEST_PORTS.apiTokenProtection;
  const API_TOKEN = 'tutto-local-dev-token';

  beforeAll(() => {
    if (globalThis.__nativeFetch) {
      globalThis.fetch = globalThis.__nativeFetch;
    }

    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, API_TOKEN, TEST_DB: 'true', FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2' },
        stdio: 'pipe'
      });

      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Server running on port')) resolve();
      });
      serverProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (!msg.includes('[client-error]')) console.error(msg);
      });

      serverProcess.on('error', (err) => reject(err));
    });
  }, 20000);

  afterAll(() => {
    if (serverProcess) serverProcess.kill();
  });

  it('GET /api/stats/global works without token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`);
    expect(res.status).toBe(200);
  });

  it('GET /api/stats/:deviceId works without token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/test-dev`);
    expect(res.status).toBe(200);
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

  it('GET /api/stats/:deviceId rejects an oversized device id with 400', async () => {
    // Same 200-char cap the socket path enforces in joinRoom.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/${'x'.repeat(201)}`);
    expect(res.status).toBe(400);
  });

  it('POST /api/stats/:deviceId rejects an oversized device id with 400 even with a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/${'x'.repeat(201)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tutto-token': API_TOKEN },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(400);
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
  let serverProcess;
  // Was '3008', which server/socket.test.ts's 'Socket updateConfig' describe
  // block also hardcodes — two different test files spawning real server
  // subprocesses on the same port race for the bind whenever vitest runs
  // both files in parallel (its default), intermittently producing
  // "websocket error" client-side in whichever test loses the race. Every
  // PORT across server/*.test.ts must stay unique for the same reason.
  const PORT = TEST_PORTS.apiClientErrorRateLimit;

  beforeAll(() => {
    if (globalThis.__nativeFetch) {
      globalThis.fetch = globalThis.__nativeFetch;
    }

    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, TEST_DB: 'true', FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2' },
        stdio: 'pipe'
      });

      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Server running on port')) resolve();
      });
      serverProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (!msg.includes('[client-error]')) console.error(msg);
      });

      serverProcess.on('error', (err) => reject(err));
    });
  }, 20000);

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
  let serverProcess;
  const PORT = TEST_PORTS.apiCorsOrigin;
  const CORS_ORIGIN = 'https://tutto.rzipas.win';

  beforeAll(() => {
    if (globalThis.__nativeFetch) {
      globalThis.fetch = globalThis.__nativeFetch;
    }

    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, CORS_ORIGIN, TEST_DB: 'true', FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2' },
        stdio: 'pipe'
      });

      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Server running on port')) resolve();
      });
      serverProcess.stderr.on('data', (data) => console.error(data.toString()));

      serverProcess.on('error', (err) => reject(err));
    });
  }, 20000);

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

describe('GET /api/stats/global rate limiting', () => {
  let serverProcess;
  const PORT = TEST_PORTS.apiGlobalStatsRateLimit;

  beforeAll(() => {
    if (globalThis.__nativeFetch) {
      globalThis.fetch = globalThis.__nativeFetch;
    }

    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, TEST_DB: 'true', FORCE_INIT_DB: 'true', TEST_TIMER_SCALE: '0.2' },
        stdio: 'pipe'
      });

      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Server running on port')) resolve();
      });
      serverProcess.stderr.on('data', (data) => console.error(data.toString()));

      serverProcess.on('error', (err) => reject(err));
    });
  }, 20000);

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
