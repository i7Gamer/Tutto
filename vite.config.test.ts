/** @vitest-environment node */
/**
 * The dev server's proxy target used to be hardcoded at localhost:3001, so a
 * dev session always talked to whatever was listening there — including a real
 * instance. That is not only reads: the client-error reporter (crashLog.ts)
 * POSTs to /api/log/client-error, so a stack trace from a half-saved file on a
 * developer's machine lands in that instance's log.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import type { ProxyOptions } from 'vite';

const ORIGINAL_TARGET = process.env.API_TARGET;
const DEFAULT_TARGET = 'http://localhost:3001';

const proxyWith = async (target: string | undefined) => {
  if (target === undefined) delete process.env.API_TARGET;
  else process.env.API_TARGET = target;
  vi.resetModules();
  const { default: configFactory } = await import('./vite.config');
  const config = await configFactory({ mode: 'development', command: 'serve' });
  // Both always exist — the config unconditionally declares them; the
  // assertions below are what fail if that ever changes.
  return config.server!.proxy!;
};

afterAll(() => {
  if (ORIGINAL_TARGET === undefined) delete process.env.API_TARGET;
  else process.env.API_TARGET = ORIGINAL_TARGET;
});

describe('coverage config', () => {
  it('includes both the client and server trees, so an untested file counts as 0% instead of being invisible', async () => {
    // Once `include` is set, @vitest/coverage-v8 always folds in every
    // matching-but-untested file as 0% (see getUntestedFiles) — there is no
    // separate `all` toggle in this vitest version, so `include` alone is
    // what makes the floor below measure "the whole tree" rather than just
    // whatever some test happened to import.
    vi.resetModules();
    const { default: configFactory } = await import('./vite.config');
    const config = await configFactory({ mode: 'test', command: 'serve' });
    const coverage = config.test!.coverage!;

    expect(coverage.include).toEqual(expect.arrayContaining(['src/**/*.{ts,tsx}', 'server/**/*.ts']));
  });

  it('excludes test files, type declarations, and the spawned-server-only files V8 cannot instrument', async () => {
    vi.resetModules();
    const { default: configFactory } = await import('./vite.config');
    const config = await configFactory({ mode: 'test', command: 'serve' });
    const coverage = config.test!.coverage!;

    expect(coverage.exclude).toEqual(expect.arrayContaining([
      '**/*.test.*',
      '**/*.d.ts',
      'src/testing/**',
      'src/sw.js',
      'server/socketTestHarness.ts',
      'server/testPorts.ts',
      'server/index.ts',
    ]));
  });
});

describe('dev server proxy', () => {
  it('forwards the API and the socket to the local server by default', async () => {
    const proxy = await proxyWith(undefined);

    expect(proxy['/api']).toBe(DEFAULT_TARGET);
    expect((proxy['/socket.io'] as ProxyOptions).target).toBe('ws://localhost:3001');
    expect((proxy['/socket.io'] as ProxyOptions).ws).toBe(true);
  });

  it('sends both to API_TARGET when one is configured', async () => {
    const proxy = await proxyWith('http://localhost:4001');

    expect(proxy['/api']).toBe('http://localhost:4001');
    expect((proxy['/socket.io'] as ProxyOptions).target).toBe('ws://localhost:4001');
  });

  it('keeps the socket on a secure scheme when the API is on one', async () => {
    const proxy = await proxyWith('https://staging.example.com');

    expect((proxy['/socket.io'] as ProxyOptions).target).toBe('wss://staging.example.com');
  });
});
