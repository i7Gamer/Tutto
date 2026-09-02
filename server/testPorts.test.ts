/** @vitest-environment node */
import { describe, it, expect, afterEach, vi } from 'vitest';

// The registry is evaluated at import time, so every case re-imports it.
const loadRegistry = async () => {
  vi.resetModules();
  return import('./testPorts');
};

describe('testPorts registry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves the base ports when no offset is set', async () => {
    vi.stubEnv('TEST_PORT_OFFSET', '');
    const { TEST_PORTS } = await loadRegistry();
    expect(TEST_PORTS.socketsRoom).toBe('3005');
  });

  it('shifts every port by TEST_PORT_OFFSET so two checkouts can run the spawned suites side by side', async () => {
    vi.stubEnv('TEST_PORT_OFFSET', '100');
    const { TEST_PORTS } = await loadRegistry();
    expect(TEST_PORTS.socketsRoom).toBe('3105');
    expect(TEST_PORTS.apiProductionCors).toBe('3118');
    // Still strings: the harness passes them straight into the child's env.
    expect(new Set(Object.values(TEST_PORTS).map(p => typeof p))).toEqual(new Set(['string']));
  });

  it('keeps the registry collision-free under an offset', async () => {
    vi.stubEnv('TEST_PORT_OFFSET', '200');
    const { TEST_PORTS } = await loadRegistry();
    const values = Object.values(TEST_PORTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(['abc', '-1', '1.5'])('refuses the offset %j instead of binding garbage', async (bad) => {
    vi.stubEnv('TEST_PORT_OFFSET', bad);
    await expect(loadRegistry()).rejects.toThrow(/TEST_PORT_OFFSET/);
  });
});
