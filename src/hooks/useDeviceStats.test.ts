import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  useDeviceStats,
  STATS_FETCH_MAX_RETRIES, STATS_FETCH_RETRY_DELAY_MS, STATS_FETCH_INITIAL_DELAY_MS,
  type DeviceStatsRetryOptions,
} from './useDeviceStats';

interface Stats { gamesPlayed: number; wins: number }

// Module-level, not per-test: the hook's own effect dependency array holds
// this reference, so a fresh object per test would refetch on every render
// exactly the way a fresh object per render would in a component.
const RETRY_OPTIONS: DeviceStatsRetryOptions<Stats> = {
  maxRetries: STATS_FETCH_MAX_RETRIES,
  retryDelayMs: STATS_FETCH_RETRY_DELAY_MS,
  initialDelayMs: STATS_FETCH_INITIAL_DELAY_MS,
  shouldRetry: (data) => !data?.gamesPlayed,
};

describe('useDeviceStats', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fetches, parses and returns the stats on success', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ gamesPlayed: 3, wins: 1 }),
    })));

    const { result } = renderHook(() => useDeviceStats<Stats>('device-1', 'normalized'));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.stats).toEqual({ gamesPlayed: 3, wins: 1 });
    expect(fetch).toHaveBeenCalledWith(
      '/api/stats/device?mode=normalized',
      { headers: { 'x-tutto-device': 'device-1' } },
    );
  });

  it('goes to error with no retry configured, after a single attempt', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDeviceStats<Stats>('device-1', 'normalized'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.stats).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a non-OK response the configured number of times, on the configured delay, then errors', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDeviceStats<Stats>('device-1', 'normalized', { retry: RETRY_OPTIONS }));

    // Attempt zero waits out the initial delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(STATS_FETCH_INITIAL_DELAY_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('loading');

    // One further attempt per retry delay, up to maxRetries retries beyond
    // the first (maxRetries + 1 attempts total).
    for (let i = 0; i < STATS_FETCH_MAX_RETRIES; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(STATS_FETCH_RETRY_DELAY_MS); });
    }

    expect(fetchMock).toHaveBeenCalledTimes(STATS_FETCH_MAX_RETRIES + 1);
    expect(result.current.status).toBe('error');
    expect(result.current.stats).toBeNull();
  });

  it('retries a thrown fetch the same way as a non-OK response, then errors', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.reject(new Error('network down')));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useDeviceStats<Stats>('device-1', 'normalized', { retry: RETRY_OPTIONS }));

    await act(async () => { await vi.advanceTimersByTimeAsync(STATS_FETCH_INITIAL_DELAY_MS); });
    for (let i = 0; i < STATS_FETCH_MAX_RETRIES; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(STATS_FETCH_RETRY_DELAY_MS); });
    }

    expect(fetchMock).toHaveBeenCalledTimes(STATS_FETCH_MAX_RETRIES + 1);
    expect(result.current.status).toBe('error');
    expect(result.current.stats).toBeNull();
  });

  it('retries while shouldRetry says the data is not ready yet, then accepts it as ready once it is', async () => {
    vi.useFakeTimers();
    let call = 0;
    const fetchMock = vi.fn(() => {
      call += 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(call < 3 ? { gamesPlayed: 0, wins: 0 } : { gamesPlayed: 5, wins: 2 }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDeviceStats<Stats>('device-1', 'normalized', { retry: RETRY_OPTIONS }));

    await act(async () => { await vi.advanceTimersByTimeAsync(STATS_FETCH_INITIAL_DELAY_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(STATS_FETCH_RETRY_DELAY_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(STATS_FETCH_RETRY_DELAY_MS); });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe('ready');
    expect(result.current.stats).toEqual({ gamesPlayed: 5, wins: 2 });
  });

  it('does not update state after unmounting mid-flight', async () => {
    let resolveFetch!: (v: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));

    const { result, unmount } = renderHook(() => useDeviceStats<Stats>('device-1', 'normalized'));
    expect(result.current.status).toBe('loading');

    unmount();
    // Resolving after unmount must not trigger a setState-on-unmounted-hook
    // warning (which vitest/RTL would surface as a failure) and must not
    // change the (now-detached) result.
    await act(async () => {
      resolveFetch({ ok: true, json: () => Promise.resolve({ gamesPlayed: 1, wins: 1 }) });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');
  });

  it('does not fetch when enabled is false', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDeviceStats<Stats>('device-1', 'normalized', { enabled: false }));

    expect(result.current.status).toBe('idle');
    expect(result.current.stats).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when deviceId or mode changes', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ gamesPlayed: url.includes('custom') ? 9 : 3, wins: 1 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ deviceId, mode }) => useDeviceStats<Stats>(deviceId, mode),
      { initialProps: { deviceId: 'device-1', mode: 'normalized' as const } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.stats).toEqual({ gamesPlayed: 3, wins: 1 });

    rerender({ deviceId: 'device-1', mode: 'custom' as const });
    await waitFor(() => expect(result.current.stats).toEqual({ gamesPlayed: 9, wins: 1 }));

    rerender({ deviceId: 'device-2', mode: 'custom' as const });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/stats/device?mode=custom',
      { headers: { 'x-tutto-device': 'device-2' } },
    ));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
