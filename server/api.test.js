/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { initDb } from './database';

describe('API Endpoints Token Protection', () => {
  let serverProcess;
  const PORT = '3006';
  const API_TOKEN = 'tutto-local-dev-token';

  beforeAll(() => {
    if (global.__nativeFetch) {
      global.fetch = global.__nativeFetch;
    }

    return new Promise((resolve, reject) => {
      serverProcess = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), 'server/index.ts'], {
        env: { ...process.env, PORT, VITE_API_TOKEN: API_TOKEN, TEST_DB: 'true', FORCE_INIT_DB: 'true' },
        stdio: 'pipe'
      });

      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('Database migrated')) {
          resolve();
        }
      });
      serverProcess.stderr.on('data', (data) => console.error(data.toString()));

      serverProcess.on('error', (err) => reject(err));
    });
  }, 10000);

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
});
