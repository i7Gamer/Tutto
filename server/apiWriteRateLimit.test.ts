/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type http from 'http';
import type { AddressInfo } from 'net';
import { registerApiRoutes } from './api';
import { updateDeviceStats, updateGlobalStats } from './database';
import { MAX_DEVICE_ID_LENGTH } from '../src/utils/configValidation';

vi.mock('./database', () => ({
  getDeviceStats: vi.fn(),
  updateDeviceStats: vi.fn(),
  getGlobalStats: vi.fn(),
  updateGlobalStats: vi.fn(),
}));

const API_TOKEN = 'admin-write-rate-limit-test-token';
const TOKEN_HEADER = 'x-tutto-token';
const WRITE_LIMIT_ENV = 'ADMIN_STATS_WRITE_LIMIT_MAX';
const GLOBAL_PATH = '/api/stats/global';
const SMALL_LIMIT = 2;
const DEFAULT_LIMIT = 60;
const WINDOW_SECONDS = 60;
const OVERSIZED_BODY_LENGTH = 110_000;
const servers: http.Server[] = [];

const listen = async (): Promise<string> => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  registerApiRoutes(app);
  const server = await new Promise<http.Server>(resolve => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const post = (baseUrl: string, path = GLOBAL_PATH, token: string | undefined = API_TOKEN,
  body = '{}', forwardedFor = '198.51.100.1') => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token === undefined ? {} : { [TOKEN_HEADER]: token }),
    'X-Forwarded-For': forwardedFor,
  },
  body,
});

const writeCount = () => vi.mocked(updateGlobalStats).mock.calls.length
  + vi.mocked(updateDeviceStats).mock.calls.length;

beforeEach(() => {
  vi.stubEnv('API_TOKEN', API_TOKEN);
  vi.stubEnv('ADMIN_AUTH_FAILURE_LIMIT_MAX', String(SMALL_LIMIT));
  vi.stubEnv(WRITE_LIMIT_ENV, String(SMALL_LIMIT));
  vi.mocked(updateGlobalStats).mockReset().mockResolvedValue(1);
  vi.mocked(updateDeviceStats).mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('authenticated admin write admission', () => {
  it('shares an exact budget across routes, buckets, devices and client IPs', async () => {
    const baseUrl = await listen();
    expect((await post(baseUrl, `${GLOBAL_PATH}?ruleset=classic`)).status).toBe(200);
    expect((await post(baseUrl, '/api/stats/device-a?mode=custom', API_TOKEN, '{}', '198.51.100.2')).status).toBe(200);
    for (const path of [`${GLOBAL_PATH}?ruleset=modernized`, '/api/stats/device-b?mode=classic']) {
      const blocked = await post(baseUrl, path, API_TOKEN, '{}', '198.51.100.3');
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: 'Too many requests' });
      const retryAfter = Number(blocked.headers.get('Retry-After'));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECONDS);
      expect(blocked.headers.get('RateLimit')).toContain(`limit=${SMALL_LIMIT}, remaining=0`);
      expect(blocked.headers.get('RateLimit-Policy')).toBe(`${SMALL_LIMIT};w=${WINDOW_SECONDS}`);
      for (const header of ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']) {
        expect(blocked.headers.has(header)).toBe(false);
      }
    }
    expect(writeCount()).toBe(SMALL_LIMIT);
    expect((await fetch(`${baseUrl}${GLOBAL_PATH}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/stats/device`, { headers: { 'x-tutto-device': 'device-a' } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
  });

  it('reserves concurrent admission before pending database writes finish', async () => {
    const baseUrl = await listen();
    let finishWrites!: () => void;
    const pendingWrite = new Promise<void>(resolve => { finishWrites = resolve; });
    vi.mocked(updateGlobalStats).mockReturnValue(pendingWrite.then(() => 1));
    vi.mocked(updateDeviceStats).mockReturnValue(pendingWrite.then(() => true));
    const requestCount = SMALL_LIMIT + 3;
    const statuses: number[] = [];
    const requests = Array.from({ length: requestCount }, (_, index) =>
      post(baseUrl, index % SMALL_LIMIT ? `/api/stats/device-${index}` : GLOBAL_PATH)
        .then(response => { statuses.push(response.status); return response.status; }));
    try {
      await vi.waitFor(() => expect(statuses).toHaveLength(requestCount - SMALL_LIMIT));
      expect(statuses).toEqual(Array(requestCount - SMALL_LIMIT).fill(429));
      expect(writeCount()).toBe(SMALL_LIMIT);
    } finally {
      finishWrites();
      await Promise.allSettled(requests);
    }
    expect(statuses.filter(status => status === 200)).toHaveLength(SMALL_LIMIT);
    expect((await post(baseUrl)).status).toBe(429);
    expect(writeCount()).toBe(SMALL_LIMIT);
  });

  it.each([
    `${GLOBAL_PATH}?ruleset=unknown`, `${GLOBAL_PATH}?mode=classic`,
    '/api/stats/device-a?mode=unknown', '/api/stats/device-a?ruleset=classic',
    `/api/stats/${'x'.repeat(MAX_DEVICE_ID_LENGTH + 1)}`,
  ])('charges validation failures without dispatching writes: %s', async path => {
    vi.stubEnv(WRITE_LIMIT_ENV, '1');
    const baseUrl = await listen();
    expect((await post(baseUrl, path)).status).toBe(400);
    expect((await post(baseUrl)).status).toBe(429);
    expect(writeCount()).toBe(0);
  });

  it('does not refund database failures', async () => {
    const baseUrl = await listen();
    vi.mocked(updateGlobalStats).mockRejectedValue(new Error('DB unavailable'));
    vi.mocked(updateDeviceStats).mockRejectedValue(new Error('DB unavailable'));
    expect((await post(baseUrl)).status).toBe(500);
    expect((await post(baseUrl, '/api/stats/device-a')).status).toBe(500);
    expect((await post(baseUrl)).status).toBe(429);
    expect(writeCount()).toBe(SMALL_LIMIT);
  });

  it('keeps failed-auth and valid-write allowances independent in both directions', async () => {
    const baseUrl = await listen();
    for (let attempt = 0; attempt < SMALL_LIMIT; attempt++) {
      expect((await post(baseUrl, '/api/stats/device-a', 'wrong')).status).toBe(403);
    }
    expect((await post(baseUrl, GLOBAL_PATH, 'wrong')).status).toBe(429);
    for (let attempt = 0; attempt < SMALL_LIMIT; attempt++) expect((await post(baseUrl)).status).toBe(200);
    expect((await post(baseUrl)).status).toBe(429);
    // A fresh failed-auth IP still has its full allowance after valid writes,
    // including write-budget rejections, from that same address.
    const freshIp = '198.51.100.2';
    expect((await post(baseUrl, GLOBAL_PATH, API_TOKEN, '{}', freshIp)).status).toBe(429);
    for (let attempt = 0; attempt < SMALL_LIMIT; attempt++) {
      expect((await post(baseUrl, GLOBAL_PATH, 'wrong', '{}', freshIp)).status).toBe(403);
    }
    expect((await post(baseUrl, GLOBAL_PATH, 'wrong', '{}', freshIp)).status).toBe(429);
    expect(writeCount()).toBe(SMALL_LIMIT);
  });

  it.each(['missing', '', 'short', 'x'.repeat(API_TOKEN.length)])('never admits an invalid token: %s', async token => {
    vi.stubEnv(WRITE_LIMIT_ENV, '1');
    const baseUrl = await listen();
    const invalid = token === 'missing'
      ? await fetch(`${baseUrl}${GLOBAL_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      : await post(baseUrl, GLOBAL_PATH, token);
    expect(invalid.status).toBe(403);
    expect(writeCount()).toBe(0);
    expect((await post(baseUrl)).status).toBe(200);
    expect((await post(baseUrl)).status).toBe(429);
    expect(writeCount()).toBe(1);
  });

  it.each([API_TOKEN, 'wrong'])('parses malformed/oversized JSON before either budget (%s)', async token => {
    vi.stubEnv(WRITE_LIMIT_ENV, '1');
    vi.stubEnv('ADMIN_AUTH_FAILURE_LIMIT_MAX', '1');
    const baseUrl = await listen();
    expect((await post(baseUrl, GLOBAL_PATH, token, '{')).status).toBe(400);
    expect((await post(baseUrl, GLOBAL_PATH, token, JSON.stringify({ value: 'x'.repeat(OVERSIZED_BODY_LENGTH) }))).status).toBe(413);
    expect(writeCount()).toBe(0);
    expect((await post(baseUrl, GLOBAL_PATH, 'wrong')).status).toBe(403);
    expect((await post(baseUrl)).status).toBe(200);
    expect(writeCount()).toBe(1);
  });

  it.each([undefined, '', ' ', 'junk', '0', '-1', '1.5', 'NaN', 'Infinity', '1e309', '9007199254740992'])(
    'uses the safe default for %s at registration', async value => {
      vi.stubEnv(WRITE_LIMIT_ENV, value);
      const baseUrl = await listen();
      const response = await post(baseUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get('RateLimit-Policy')).toBe(`${DEFAULT_LIMIT};w=${WINDOW_SECONDS}`);
    });

  it('enforces the default N/N+1 boundary', async () => {
    vi.stubEnv(WRITE_LIMIT_ENV, undefined);
    const baseUrl = await listen();
    for (let attempt = 0; attempt < DEFAULT_LIMIT; attempt++) expect((await post(baseUrl)).status).toBe(200);
    expect((await post(baseUrl)).status).toBe(429);
    expect(writeCount()).toBe(DEFAULT_LIMIT);
  });

  it('reads overrides at registration and keeps app budgets independent', async () => {
    vi.stubEnv(WRITE_LIMIT_ENV, '1');
    const first = await listen();
    vi.stubEnv(WRITE_LIMIT_ENV, String(SMALL_LIMIT));
    const second = await listen();
    expect((await post(first)).status).toBe(200);
    expect((await post(first)).status).toBe(429);
    for (let attempt = 0; attempt < SMALL_LIMIT; attempt++) expect((await post(second)).status).toBe(200);
    expect((await post(second)).status).toBe(429);
    expect(writeCount()).toBe(1 + SMALL_LIMIT);
  });
});
