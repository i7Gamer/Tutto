/** @vitest-environment node */
/**
 * The dev server's proxy target used to be hardcoded at localhost:3001, so a
 * dev session always talked to whatever was listening there — including a real
 * instance. That is not only reads: the client-error reporter (crashLog.ts)
 * POSTs to /api/log/client-error, so a stack trace from a half-saved file on a
 * developer's machine lands in that instance's log.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';

const ORIGINAL_TARGET = process.env.API_TARGET;
const DEFAULT_TARGET = 'http://localhost:3001';

const proxyWith = async (target) => {
  if (target === undefined) delete process.env.API_TARGET;
  else process.env.API_TARGET = target;
  vi.resetModules();
  const { default: configFactory } = await import('./vite.config.js');
  const config = await configFactory({ mode: 'development', command: 'serve' });
  return config.server.proxy;
};

afterAll(() => {
  if (ORIGINAL_TARGET === undefined) delete process.env.API_TARGET;
  else process.env.API_TARGET = ORIGINAL_TARGET;
});

describe('dev server proxy', () => {
  it('forwards the API and the socket to the local server by default', async () => {
    const proxy = await proxyWith(undefined);

    expect(proxy['/api']).toBe(DEFAULT_TARGET);
    expect(proxy['/socket.io'].target).toBe('ws://localhost:3001');
    expect(proxy['/socket.io'].ws).toBe(true);
  });

  it('sends both to API_TARGET when one is configured', async () => {
    const proxy = await proxyWith('http://localhost:4001');

    expect(proxy['/api']).toBe('http://localhost:4001');
    expect(proxy['/socket.io'].target).toBe('ws://localhost:4001');
  });

  it('keeps the socket on a secure scheme when the API is on one', async () => {
    const proxy = await proxyWith('https://staging.example.com');

    expect(proxy['/socket.io'].target).toBe('wss://staging.example.com');
  });
});
