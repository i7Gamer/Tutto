import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useWakeLock } from './useWakeLock';

// A minimal fake WakeLockSentinel: tracks its own release listeners so tests
// can simulate the browser firing an automatic release (e.g. on
// backgrounding), not just our own explicit release() call.
function createFakeSentinel() {
  const releaseListeners: (() => void)[] = [];
  const sentinel = {
    released: false,
    release: vi.fn(async () => {
      sentinel.released = true;
      releaseListeners.forEach(fn => fn());
    }),
    addEventListener: vi.fn((event: string, fn: () => void) => {
      if (event === 'release') releaseListeners.push(fn);
    }),
    removeEventListener: vi.fn(),
  };
  return sentinel;
}

describe('useWakeLock', () => {
  afterEach(() => {
    // @ts-expect-error test-only cleanup of a jsdom-absent API
    delete navigator.wakeLock;
    vi.restoreAllMocks();
  });

  it('does nothing when the Wake Lock API is unsupported', () => {
    expect(() => renderHook(() => useWakeLock())).not.toThrow();
  });

  it('requests a screen wake lock on mount', async () => {
    const sentinel = createFakeSentinel();
    const request = vi.fn().mockResolvedValue(sentinel);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    renderHook(() => useWakeLock());

    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
  });

  it('releases the sentinel on unmount', async () => {
    const sentinel = createFakeSentinel();
    const request = vi.fn().mockResolvedValue(sentinel);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    const { unmount } = renderHook(() => useWakeLock());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    unmount();

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('does not crash when the request is rejected', async () => {
    const request = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    renderHook(() => useWakeLock());

    await waitFor(() => expect(request).toHaveBeenCalled());
  });

  it('re-requests the lock once the tab becomes visible again after a browser-initiated release', async () => {
    const firstSentinel = createFakeSentinel();
    const secondSentinel = createFakeSentinel();
    const request = vi.fn()
      .mockResolvedValueOnce(firstSentinel)
      .mockResolvedValueOnce(secondSentinel);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    renderHook(() => useWakeLock());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    // Simulate the browser auto-releasing the lock while backgrounded (e.g.
    // the tab was hidden) — this fires the sentinel's own 'release' event,
    // which is exactly what the hook needs to notice before it will
    // re-request on the next visibilitychange.
    await firstSentinel.release();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('does not re-request while a lock is still held', async () => {
    const sentinel = createFakeSentinel();
    const request = vi.fn().mockResolvedValue(sentinel);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    renderHook(() => useWakeLock());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not acquire a second lock while a request is still in flight', async () => {
    const sentinel = createFakeSentinel();
    let settleRequest: (s: unknown) => void = () => {};
    const request = vi.fn(() => new Promise((resolve) => { settleRequest = resolve; }));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    const { unmount } = renderHook(() => useWakeLock());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    // Two rapid app-switches (mobile) while the mount request is still
    // unresolved. `sentinel` is only assigned once that promise settles, so a
    // bare `!sentinel` guard still reads null here and would let each of
    // these acquire a lock of its own — and only the last one assigned ever
    // gets released, leaving the screen awake after the game ends.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(1);

    settleRequest(sentinel);
    await waitFor(() => expect(sentinel.addEventListener).toHaveBeenCalled());

    unmount();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('ignores a release fired by a sentinel that is no longer the one held', async () => {
    const firstSentinel = createFakeSentinel();
    const secondSentinel = createFakeSentinel();
    const request = vi.fn()
      .mockResolvedValueOnce(firstSentinel)
      .mockResolvedValueOnce(secondSentinel);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    renderHook(() => useWakeLock());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    await firstSentinel.release();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    // A late/duplicate release event from the SUPERSEDED sentinel must not
    // clear the reference to the one now held — that would strand the live
    // lock (never released on unmount) and re-request on top of it.
    await firstSentinel.release();
    document.dispatchEvent(new Event('visibilitychange'));

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('re-requests the lock once the tab becomes visible again if the initial request was rejected', async () => {
    const sentinel = createFakeSentinel();
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(sentinel);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    renderHook(() => useWakeLock());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});
