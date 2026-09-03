/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveInitialTheme } from './themePreference';

// Same shape as reducedMotion.test.ts's stub: jsdom has no matchMedia unless a
// suite provides one, which is also what a browser too old to know the query
// looks like — both must read as "no preference" (light) rather than throwing.
const stubMatchMedia = (matches: boolean) => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveInitialTheme', () => {
  it('follows the OS when nothing is stored and the OS prefers dark', () => {
    stubMatchMedia(true);

    expect(resolveInitialTheme(null)).toBe('dark');
  });

  it('follows the OS when nothing is stored and the OS prefers light', () => {
    stubMatchMedia(false);

    expect(resolveInitialTheme(null)).toBe('light');
  });

  it('keeps an explicit stored choice over a conflicting OS preference', () => {
    stubMatchMedia(true);

    expect(resolveInitialTheme('light')).toBe('light');
  });

  it('keeps an explicit stored choice that agrees with the OS preference', () => {
    stubMatchMedia(false);

    expect(resolveInitialTheme('dark')).toBe('dark');
  });

  it('asks the media feature this depends on, not a typo of it', () => {
    // A misspelled query would silently never match dark mode, and the
    // fallback-to-light branch would swallow the bug with nothing failing.
    stubMatchMedia(true);

    resolveInitialTheme(null);

    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
  });

  it('reads as light where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);

    expect(resolveInitialTheme(null)).toBe('light');
  });

  it('treats a corrupted stored value as absent and falls back to the OS', () => {
    stubMatchMedia(true);

    expect(resolveInitialTheme('not-a-theme')).toBe('dark');
  });
});
