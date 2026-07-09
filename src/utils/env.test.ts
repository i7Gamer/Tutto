import { describe, it, expect, afterEach, vi } from 'vitest';
import { isTestEnv } from './env';

describe('isTestEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete (window as { __TEST_MODE__?: boolean }).__TEST_MODE__;
  });

  it('returns true under the real Vitest environment (import.meta.env.MODE === "test")', () => {
    expect(isTestEnv()).toBe(true);
  });

  it('stays true when window.__TEST_MODE__ is also set', () => {
    window.__TEST_MODE__ = true;
    expect(isTestEnv()).toBe(true);
  });

  it('falls back to window.__TEST_MODE__ when MODE is not "test"', () => {
    vi.stubEnv('MODE', 'production');
    window.__TEST_MODE__ = true;
    expect(isTestEnv()).toBe(true);
  });

  it('returns false when neither MODE nor window.__TEST_MODE__ indicate a test run', () => {
    vi.stubEnv('MODE', 'production');
    window.__TEST_MODE__ = false;
    expect(isTestEnv()).toBe(false);
  });

  it('does not throw when window is undefined (SSR-safe)', () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error -- simulating an SSR context with no window global
    delete globalThis.window;
    try {
      // MODE is still 'test' here, so this also confirms the window guard's
      // false branch correctly falls through to the MODE check instead of
      // throwing on `window.__TEST_MODE__`.
      expect(isTestEnv()).toBe(true);
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
