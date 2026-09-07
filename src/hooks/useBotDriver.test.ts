import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useBotDriver, type UseBotDriverOptions } from './useBotDriver';
import { BOT_THINK_MS, BOT_REVEAL_MS } from '../utils/uiTimings';

describe('useBotDriver', () => {
  const base = (over: Partial<UseBotDriverOptions> = {}): UseBotDriverOptions => ({
    active: true,
    idle: true,
    revealPending: false,
    tableKey: 'table-1',
    onStep: vi.fn(),
    onDismissReveal: vi.fn(),
    ...over,
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('takes a step once the table has been idle for the think delay', () => {
    const onStep = vi.fn();
    renderHook(() => useBotDriver(base({ onStep })));

    act(() => vi.advanceTimersByTime(BOT_THINK_MS - 1));
    expect(onStep).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a human, and nothing while the table is busy', () => {
    const onStep = vi.fn();
    const { rerender } = renderHook((props: UseBotDriverOptions) => useBotDriver(props), {
      initialProps: base({ active: false, onStep }),
    });
    act(() => vi.advanceTimersByTime(BOT_THINK_MS * 2));
    expect(onStep).not.toHaveBeenCalled();

    rerender(base({ active: true, idle: false, onStep }));
    act(() => vi.advanceTimersByTime(BOT_THINK_MS * 2));
    expect(onStep).not.toHaveBeenCalled();
  });

  it('drops a pending step when the table stops being idle first', () => {
    const onStep = vi.fn();
    const { rerender } = renderHook((props: UseBotDriverOptions) => useBotDriver(props), {
      initialProps: base({ onStep }),
    });
    act(() => vi.advanceTimersByTime(BOT_THINK_MS - 1));
    rerender(base({ idle: false, onStep }));
    act(() => vi.advanceTimersByTime(BOT_THINK_MS));
    expect(onStep).not.toHaveBeenCalled();
  });

  it('steps again after the table changes under it (a selection landed)', () => {
    const onStep = vi.fn();
    const { rerender } = renderHook((props: UseBotDriverOptions) => useBotDriver(props), {
      initialProps: base({ onStep }),
    });
    act(() => vi.advanceTimersByTime(BOT_THINK_MS));
    expect(onStep).toHaveBeenCalledTimes(1);

    // Same table, nothing new: no second step on its own.
    act(() => vi.advanceTimersByTime(BOT_THINK_MS * 3));
    expect(onStep).toHaveBeenCalledTimes(1);

    rerender(base({ tableKey: 'table-2', onStep }));
    act(() => vi.advanceTimersByTime(BOT_THINK_MS));
    expect(onStep).toHaveBeenCalledTimes(2);
  });

  it('dismisses a drawn-card reveal instead of stepping, after the reveal delay', () => {
    const onStep = vi.fn();
    const onDismissReveal = vi.fn();
    renderHook(() => useBotDriver(base({ revealPending: true, onStep, onDismissReveal })));

    act(() => vi.advanceTimersByTime(BOT_REVEAL_MS - 1));
    expect(onDismissReveal).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismissReveal).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(BOT_THINK_MS * 2));
    expect(onStep).not.toHaveBeenCalled();
  });

  it('calls the latest step handler, not the one it was armed with', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = renderHook((props: UseBotDriverOptions) => useBotDriver(props), {
      initialProps: base({ onStep: stale }),
    });
    rerender(base({ onStep: fresh }));
    act(() => vi.advanceTimersByTime(BOT_THINK_MS));
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('cancels its timer on unmount', () => {
    const onStep = vi.fn();
    const { unmount } = renderHook(() => useBotDriver(base({ onStep })));
    unmount();
    act(() => vi.advanceTimersByTime(BOT_THINK_MS * 2));
    expect(onStep).not.toHaveBeenCalled();
  });
});
