import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAutoContinueCountdown } from './useAutoContinueCountdown';

// Control isTestEnv so we can exercise both the instant (test) path and the
// real 3-2-1 countdown path.
const isTestEnv = vi.fn();
vi.mock('../utils/env', () => ({ isTestEnv: () => isTestEnv() }));

describe('useAutoContinueCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isTestEnv.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stays idle (null) while shouldStart is false', () => {
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoContinueCountdown({ shouldStart: false, onElapsed }));

    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(5000));
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it('counts down 3 → 2 → 1 then calls onElapsed', () => {
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoContinueCountdown({ shouldStart: true, onElapsed }));

    expect(result.current).toBe(3);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(1);

    expect(onElapsed).not.toHaveBeenCalled();

    // Main 3s timer elapses.
    act(() => vi.advanceTimersByTime(1000));
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it('only starts once and ignores shouldStart toggling back and forth', () => {
    const onElapsed = vi.fn();
    const { result, rerender } = renderHook(
      ({ shouldStart }) => useAutoContinueCountdown({ shouldStart, onElapsed }),
      { initialProps: { shouldStart: true } }
    );

    expect(result.current).toBe(3);

    rerender({ shouldStart: false });
    rerender({ shouldStart: true });

    // Still a single timer — onElapsed fires exactly once after 3s.
    act(() => vi.advanceTimersByTime(3000));
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it('uses the latest onElapsed without restarting the timer', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useAutoContinueCountdown({ shouldStart: true, onElapsed: cb }),
      { initialProps: { cb: first } }
    );

    act(() => vi.advanceTimersByTime(1500));
    rerender({ cb: second });
    act(() => vi.advanceTimersByTime(1500));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('in test mode collapses to 0 and fires immediately', () => {
    isTestEnv.mockReturnValue(true);
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoContinueCountdown({ shouldStart: true, onElapsed }));

    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(0));
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });
});
