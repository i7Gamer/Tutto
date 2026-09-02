/** @vitest-environment node */
/**
 * Unit coverage for the child-env construction startTestServer (see
 * ./socketTestHarness) uses when it spawns the real server as a subprocess.
 *
 * Extracted into a pure buildChildEnv so this is testable without spawning
 * anything: the harness used to hand the child `...process.env` wholesale
 * (plus dotenv.config() pulling in a real .env on top), so a developer's own
 * CORS_ORIGIN / TRUST_PROXY / API_TOKEN / ALLOWED_HOST silently changed what
 * the spawned test servers did — and differed between machines and CI. Only
 * an explicit allow-list, plus whatever a call passes as `overrides`, should
 * reach the child.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ChildProcess } from 'child_process';
import { buildChildEnv, startTestServer } from './socketTestHarness';
import { TEST_PORTS } from './testPorts';
import { SERVER_BOOT_TIMEOUT_MS } from './testTimeouts';

// A stand-in for a developer's real, populated .env sitting in process.env —
// exactly what dotenv.config() used to load. Every key here is a real one
// from .env.example; none of them may reach a spawned test server unless a
// test opts in via `overrides`.
const POISONED_PARENT_ENV = {
  PATH: '/usr/bin:/bin',
  CORS_ORIGIN: 'https://evil.example',
  API_TOKEN: 'a-developers-real-secret',
  TRUST_PROXY: '1',
  ALLOWED_HOST: 'evil.example',
  DB_PATH: '/home/dev/real-stats.db',
  TUTTO_STATUS_LINE: '1',
  API_TARGET: 'http://localhost:9999',
  SOME_UNRELATED_TOOL_VAR: 'whatever',
};

describe('buildChildEnv', () => {
  it('keeps only the allow-listed keys from the parent env', () => {
    const child = buildChildEnv(POISONED_PARENT_ENV);
    expect(child.PATH).toBe('/usr/bin:/bin');
  });

  it('strips every dangerous config var the parent env may carry', () => {
    const child = buildChildEnv(POISONED_PARENT_ENV);
    expect(child.CORS_ORIGIN).toBeUndefined();
    expect(child.API_TOKEN).toBeUndefined();
    expect(child.TRUST_PROXY).toBeUndefined();
    expect(child.ALLOWED_HOST).toBeUndefined();
    expect(child.DB_PATH).toBeUndefined();
    expect(child.TUTTO_STATUS_LINE).toBeUndefined();
    expect(child.API_TARGET).toBeUndefined();
  });

  it('strips arbitrary parent env vars that are not on the allow-list at all', () => {
    const child = buildChildEnv(POISONED_PARENT_ENV);
    expect(child.SOME_UNRELATED_TOOL_VAR).toBeUndefined();
  });

  it('passes through TEST_PORT_OFFSET from the parent env', () => {
    const child = buildChildEnv({ TEST_PORT_OFFSET: '100' });
    expect(child.TEST_PORT_OFFSET).toBe('100');
  });

  it('passes through the vitest-injected TEST_DB and TEST_TIMER_SCALE', () => {
    const child = buildChildEnv({ TEST_DB: 'true', TEST_TIMER_SCALE: '0.2' });
    expect(child.TEST_DB).toBe('true');
    expect(child.TEST_TIMER_SCALE).toBe('0.2');
  });

  it('passes through the connection/room limit overrides vite.config.ts injects for the test run', () => {
    // Not in the harness's own list of things it sets — these come from the
    // PARENT (vitest) env, and several spawned suites rely on inheriting the
    // raised values so their bursts of same-address connections/rooms do not
    // trip the production defaults (see vite.config.ts `test.env`).
    const child = buildChildEnv({ SOCKET_CONN_LIMIT_MAX: '1000000', MAX_ROOMS_PER_ADDRESS: '1000000' });
    expect(child.SOCKET_CONN_LIMIT_MAX).toBe('1000000');
    expect(child.MAX_ROOMS_PER_ADDRESS).toBe('1000000');
  });

  it('passes through the stats rate-limit override vite.config.ts injects for the test run', () => {
    // Same shape as SOCKET_CONN_LIMIT_MAX/MAX_ROOMS_PER_ADDRESS above: the
    // ~3s-per-attempt polling in sockets.stats.test.ts shares one server
    // process and one 60s window across every test in the file, so a single
    // failed poll (its full attempt budget) can exhaust the production
    // default and 429 every test after it.
    const child = buildChildEnv({ STATS_RATE_LIMIT_MAX: '1000000' });
    expect(child.STATS_RATE_LIMIT_MAX).toBe('1000000');
  });

  it('passes through both Windows- and POSIX-cased path/system variables', () => {
    const child = buildChildEnv({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' });
    expect(child.Path).toBe('C:\\Windows\\System32');
    expect(child.SystemRoot).toBe('C:\\Windows');
  });

  it('lets an override win over an allow-listed parent value', () => {
    const child = buildChildEnv({ PATH: '/from-parent' }, { PATH: '/from-override' });
    expect(child.PATH).toBe('/from-override');
  });

  it('lets an override reintroduce a key the allow-list would otherwise strip', () => {
    // This is how a test opts a dangerous-by-default var back in on purpose
    // (e.g. api.test.ts's CORS_ORIGIN suite) — explicit per-call, never ambient.
    const child = buildChildEnv(POISONED_PARENT_ENV, { CORS_ORIGIN: 'https://tutto.example.com' });
    expect(child.CORS_ORIGIN).toBe('https://tutto.example.com');
  });

  it('includes an override key even when the parent env has no such key at all', () => {
    const child = buildChildEnv({}, { PORT: '3999' });
    expect(child).toEqual({ PORT: '3999' });
  });

  it('invents no keys when both parent env and overrides are empty', () => {
    expect(buildChildEnv({})).toEqual({});
  });
});

describe("startTestServer does not leak the developer's ambient env into the spawned server", () => {
  let serverProcess: ChildProcess | undefined;
  const PORT = TEST_PORTS.socketTestHarnessEnvIsolation;
  const POISONED_CORS_ORIGIN = 'https://evil.example';
  let previousCorsOrigin: string | undefined;

  beforeAll(async () => {
    // Stands in for a developer's real .env leaking into process.env — what
    // dotenv.config() used to do before this harness stopped calling it. If
    // buildChildEnv's allow-list ever regresses back to spreading
    // `...process.env` wholesale, the spawned server below reflects this
    // origin instead of its own default, and the assertion catches it.
    previousCorsOrigin = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = POISONED_CORS_ORIGIN;
    try {
      // Deliberately no `env` override: this is exactly the ambient,
      // not-explicitly-opted-in case the isolation is meant to cover.
      serverProcess = await startTestServer(PORT);
    } finally {
      if (previousCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = previousCorsOrigin;
    }
  }, SERVER_BOOT_TIMEOUT_MS);

  afterAll(() => {
    serverProcess?.kill();
  });

  it('answers with its own default CORS origin, not the poisoned parent one', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/stats/global`, {
      headers: { Origin: POISONED_CORS_ORIGIN },
    });
    // Outside production with no CORS_ORIGIN configured, the server answers
    // '*' (see resolveCorsOrigin in server/startupGuards.ts) — a value that
    // could only appear here if the poisoned CORS_ORIGIN above was stripped
    // before reaching the child.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
