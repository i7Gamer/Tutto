import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAutoContinueCountdown } from './useAutoContinueCountdown';

describe('useAutoContinueCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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

  it('restarts when the summary underneath it is replaced', () => {
    // A classic chain whose drawn card is discarded swaps the summary while it
    // is already showing: the forfeit screen becomes "Tutto! Bank N points"
    // (DRAW_ABANDONED). shouldStart never goes false→true across that, so the
    // old countdown kept running and the new summary inherited whatever was
    // left of it — possibly under a second before it auto-continued.
    const onElapsed = vi.fn();
    const { result, rerender } = renderHook(
      ({ key }) => useAutoContinueCountdown({ shouldStart: true, onElapsed, restartKey: key }),
      { initialProps: { key: 'forfeit' } },
    );

    // One second per act(), like the countdown test above: each tick schedules
    // the next only after its own state update, so a single 2000ms advance
    // lands just one of them.
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current, 'two of the three seconds are gone').toBe(1);

    rerender({ key: 'banked' });

    expect(result.current, 'the new summary gets the full countdown').toBe(3);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it('does not restart while the same summary stays up', () => {
    // The control: an unrelated re-render must not keep the countdown alive
    // forever.
    const onElapsed = vi.fn();
    const { result, rerender } = renderHook(
      ({ key }) => useAutoContinueCountdown({ shouldStart: true, onElapsed, restartKey: key }),
      { initialProps: { key: 'forfeit' } },
    );

    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    rerender({ key: 'forfeit' });

    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(1000));
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it('counts down 3 → 2 → 1 → 0, showing 0 before calling onElapsed', () => {
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoContinueCountdown({ shouldStart: true, onElapsed }));

    expect(result.current).toBe(3);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2);
    expect(onElapsed).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(1);
    expect(onElapsed).not.toHaveBeenCalled();

    // The countdown must actually reach 0 (and be rendered) before onElapsed
    // fires. Previously a second, independently-scheduled 3s timer raced this
    // final decrement and always won the tie, so the display jumped straight
    // from 1 to null without ever showing 0.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(0);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  // shouldStart going false→true→false→true used to latch on the FIRST
  // start and ignore every later transition — right for the only case that
  // used to exist (a summary that opens once and stays open), wrong once a
  // caller (the Stop card) can go through several shouldStart cycles across
  // its lifetime: the countdown reached 0 once and then sat there forever,
  // and a later start could not begin a fresh one.
  it('shouldStart going false clears the countdown to null and stops ticking', () => {
    const onElapsed = vi.fn();
    const { result, rerender } = renderHook(
      ({ shouldStart }) => useAutoContinueCountdown({ shouldStart, onElapsed }),
      { initialProps: { shouldStart: true } }
    );

    expect(result.current).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(2);

    rerender({ shouldStart: false });
    expect(result.current).toBeNull();

    // No pending timer survives the stop — it must not resurrect on its own.
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBeNull();
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it('shouldStart returning true after going false starts a fresh countdown', () => {
    const onElapsed = vi.fn();
    const { result, rerender } = renderHook(
      ({ shouldStart }) => useAutoContinueCountdown({ shouldStart, onElapsed }),
      { initialProps: { shouldStart: true } }
    );

    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(1);

    rerender({ shouldStart: false });
    expect(result.current).toBeNull();

    rerender({ shouldStart: true });
    // A fresh countdown, not a resumption of the one that was almost done.
    expect(result.current).toBe(3);

    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it('after reaching 0 with shouldStart still true, the value stays 0 and onElapsed fires exactly once', () => {
    // DiceSummary (and the Stop card) must be able to render 0 — see the
    // comment in the hook about the display needing to actually show 0
    // before onElapsed commits anything.
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoContinueCountdown({ shouldStart: true, onElapsed }));

    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(0);
    expect(onElapsed).toHaveBeenCalledTimes(1);

    // Nothing further ticks it past 0, and onElapsed does not re-fire.
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(0);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it('starts from a custom `seconds` instead of the 3s default, for a caller with its own duration', () => {
    // The Stop card's own auto-continue (useStopCardAutoContinue) reuses this
    // hook for its display countdown but runs on a longer clock than the dice
    // summary's — `seconds` is what lets one hook serve both without forcing
    // them to the same pace.
    const onElapsed = vi.fn();
    const { result } = renderHook(() => useAutoContinueCountdown({ shouldStart: true, onElapsed, seconds: 5 }));

    expect(result.current).toBe(5);

    for (let i = 0; i < 4; i++) {
      act(() => vi.advanceTimersByTime(1000));
    }
    expect(result.current).toBe(1);
    expect(onElapsed).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(0);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it('uses the latest onElapsed without restarting the timer', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useAutoContinueCountdown({ shouldStart: true, onElapsed: cb }),
      { initialProps: { cb: first } }
    );

    act(() => vi.advanceTimersByTime(1000));
    act(() => vi.advanceTimersByTime(1000));
    rerender({ cb: second });
    act(() => vi.advanceTimersByTime(1000));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
