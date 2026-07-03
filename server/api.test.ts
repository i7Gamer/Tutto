/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';

describe('API Endpoints Token Protection', () => {
  let serverProcess;
  const PORT = '3006';
  const API_TOKEN = 'tutto-local-dev-token';

  beforeAll(() => {
    if (globalThis.__nativeFetch) {
      globalThis.fetch = globalThis.__nativeFetch;
    }

    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, API_TOKEN, TEST_DB: 'true', FORCE_INIT_DB: 'true' },
        stdio: 'pipe'
      });

      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Database migrated')) resolve();
      });
      serverProcess.stderr.on('data', (data) => console.error(data.toString()));

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

describe('CORS_ORIGIN configuration', () => {
  let serverProcess;
  const PORT = '3007';
  const CORS_ORIGIN = 'https://tutto.rzipas.win';

  beforeAll(() => {
    if (globalThis.__nativeFetch) {
      globalThis.fetch = globalThis.__nativeFetch;
    }

    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, CORS_ORIGIN, TEST_DB: 'true', FORCE_INIT_DB: 'true' },
        stdio: 'pipe'
      });

      let stdout = '';
      serverProcess.stdout.on('data', (data) => {
        stdout += data.toString();
        if (stdout.includes('Database migrated')) resolve();
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
