/** @vitest-environment node */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type http from 'http';
import type { AddressInfo } from 'net';
import { registerApiRoutes } from './api';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
  updateDeviceStats: vi.fn(),
  getGlobalStats: vi.fn(),
  updateGlobalStats: vi.fn().mockResolvedValue(undefined),
}));

const API_TOKEN = 'admin-rate-limit-test-token';
const TOKEN_HEADER = 'x-tutto-token';

const listen = async (): Promise<{ server: http.Server; baseUrl: string }> => {
  const app = express();
  app.use(express.json());
  registerApiRoutes(app);
  const server = await new Promise<http.Server>(resolve => {
    const listening = app.listen(0, () => resolve(listening));
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

describe('failed admin authentication budget', () => {
  let server: http.Server;
  let baseUrl: string;
  let previousToken: string | undefined;
  let previousLimit: string | undefined;

  beforeAll(async () => {
    previousToken = process.env.API_TOKEN;
    previousLimit = process.env.ADMIN_AUTH_FAILURE_LIMIT_MAX;
    process.env.API_TOKEN = API_TOKEN;
    process.env.ADMIN_AUTH_FAILURE_LIMIT_MAX = '2';
    ({ server, baseUrl } = await listen());
  });

  afterAll(async () => {
    if (previousToken === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = previousToken;
    if (previousLimit === undefined) delete process.env.ADMIN_AUTH_FAILURE_LIMIT_MAX;
    else process.env.ADMIN_AUTH_FAILURE_LIMIT_MAX = previousLimit;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  const post = (path: string, token: string, forwardedFor?: string) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: token,
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
    },
    body: '{}',
  });

  it('shares failed attempts across protected routes while valid automation remains usable', async () => {
    expect((await post('/api/stats/global', 'wrong', '198.51.100.1')).status).toBe(403);
    expect((await post('/api/stats/device-a', 'wrong', '198.51.100.2')).status).toBe(403);
    const blocked = await post('/api/stats/global', 'wrong', '198.51.100.3');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();

    expect((await post('/api/stats/global', API_TOKEN)).status).toBe(200);
  });
});

describe('JSON parsing precedes failed authentication accounting', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.API_TOKEN = API_TOKEN;
    process.env.ADMIN_AUTH_FAILURE_LIMIT_MAX = '1';
    ({ server, baseUrl } = await listen());
  });

  afterAll(async () => {
    delete process.env.API_TOKEN;
    delete process.env.ADMIN_AUTH_FAILURE_LIMIT_MAX;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('answers oversized JSON before auth and does not consume the failed-auth bucket', async () => {
    const oversized = await fetch(`${baseUrl}/api/stats/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: 'wrong' },
      body: JSON.stringify({ value: 'x'.repeat(110_000) }),
    });
    expect(oversized.status).toBe(413);

    const firstFailure = await fetch(`${baseUrl}/api/stats/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: 'wrong' },
      body: '{}',
    });
    expect(firstFailure.status).toBe(403);

    const exhausted = await fetch(`${baseUrl}/api/stats/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: 'wrong' },
      body: '{}',
    });
    expect(exhausted.status).toBe(429);
  });
});
