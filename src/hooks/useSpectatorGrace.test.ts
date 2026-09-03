import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSpectatorGrace } from './useSpectatorGrace';

const GRACE_MS = 4000;

describe('useSpectatorGrace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stays false (not elapsed) while inactive', () => {
    const { result } = renderHook(() => useSpectatorGrace({ active: false, turnKey: 'p0-r1', graceMs: GRACE_MS }));

    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(GRACE_MS + 1000));
    expect(result.current).toBe(false);
  });

  it('stays false until the grace period elapses, then flips true', () => {
    const { result } = renderHook(() => useSpectatorGrace({ active: true, turnKey: 'p0-r1', graceMs: GRACE_MS }));

    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(GRACE_MS - 1));
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('cancels and restarts the grace period when the turn key changes', () => {
    const { result, rerender } = renderHook(
      ({ turnKey }) => useSpectatorGrace({ active: true, turnKey, graceMs: GRACE_MS }),
      { initialProps: { turnKey: 'p0-r1' } },
    );

    act(() => vi.advanceTimersByTime(GRACE_MS - 500));
    expect(result.current, 'almost elapsed for the first turn').toBe(false);

    // The active player changes (or the round advances) before the old grace
    // period ran out — the countdown must restart from zero for the new turn,
    // not inherit whatever was left of the previous one.
    rerender({ turnKey: 'p1-r1' });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current, 'the new turn only just started waiting').toBe(false);

    act(() => vi.advanceTimersByTime(GRACE_MS - 500));
    expect(result.current).toBe(true);
  });

  it('cancels the grace period once the caller reports live state arrived (active goes false)', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useSpectatorGrace({ active, turnKey: 'p0-r1', graceMs: GRACE_MS }),
      { initialProps: { active: true } },
    );

    act(() => vi.advanceTimersByTime(GRACE_MS - 100));
    expect(result.current).toBe(false);

    // Live turn state arrives — the caller stops waiting.
    rerender({ active: false });

    act(() => vi.advanceTimersByTime(GRACE_MS));
    expect(result.current, 'no longer active, so the grace timer must not fire').toBe(false);
  });

  it('clears its timer on unmount without throwing', () => {
    const { unmount } = renderHook(() => useSpectatorGrace({ active: true, turnKey: 'p0-r1', graceMs: GRACE_MS }));

    unmount();

    expect(() => act(() => vi.advanceTimersByTime(GRACE_MS + 1000))).not.toThrow();
  });
});
