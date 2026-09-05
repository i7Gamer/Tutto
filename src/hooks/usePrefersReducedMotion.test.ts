import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

// Mirrors the matchMedia stub in reducedMotion.test.ts: jsdom has no
// matchMedia unless a suite provides one, and this hook must read that
// (and a browser too old to know the query) as "no preference" rather than
// throwing — the same default the platform itself uses.
const stubMatchMedia = (matches: boolean) => {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn((event: string, fn: (e: MediaQueryListEvent) => void) => {
      if (event === 'change') listeners.push(fn);
    }),
    removeEventListener: vi.fn((event: string, fn: (e: MediaQueryListEvent) => void) => {
      if (event === 'change') {
        const idx = listeners.indexOf(fn);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    }),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  const fireChange = (next: boolean) => {
    mql.matches = next;
    listeners.forEach((fn) => fn({ matches: next } as MediaQueryListEvent));
  };
  return { mql, fireChange };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usePrefersReducedMotion', () => {
  it('is true when the OS asks for reduced motion', () => {
    stubMatchMedia(true);

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(true);
  });

  it('is false when it does not', () => {
    stubMatchMedia(false);

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });

  it('reads as no-preference where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);

    const { result } = renderHook(() => usePrefersReducedMotion());

    expect(result.current).toBe(false);
  });

  it('updates when the OS setting changes while mounted', () => {
    const { fireChange } = stubMatchMedia(false);

    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => { fireChange(true); });

    expect(result.current).toBe(true);
  });

  it('stops listening once unmounted', () => {
    const { mql } = stubMatchMedia(false);

    const { unmount } = renderHook(() => usePrefersReducedMotion());
    unmount();

    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
