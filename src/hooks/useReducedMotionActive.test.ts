import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useReducedMotionActive } from './useReducedMotionActive';
import { useGameStore } from '../store/useGameStore';

// Mirrors usePrefersReducedMotion.test.ts's matchMedia stub. jsdom has no
// matchMedia unless a suite provides one.
const stubMatchMedia = (matches: boolean) => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
};

describe('useReducedMotionActive', () => {
  const originalOverride = useGameStore.getState().motionOverride;

  beforeEach(() => {
    useGameStore.setState({ motionOverride: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useGameStore.setState({ motionOverride: originalOverride });
  });

  it('is true when the OS asks for reduced motion and the lobby override is off', () => {
    stubMatchMedia(true);
    expect(renderHook(() => useReducedMotionActive()).result.current).toBe(true);
  });

  it('is false when the Animations override ("Always on") is set, whatever the OS says', () => {
    stubMatchMedia(true);
    useGameStore.setState({ motionOverride: true });
    expect(renderHook(() => useReducedMotionActive()).result.current).toBe(false);
  });

  it('is false when the OS has no preference', () => {
    stubMatchMedia(false);
    expect(renderHook(() => useReducedMotionActive()).result.current).toBe(false);
  });
});
