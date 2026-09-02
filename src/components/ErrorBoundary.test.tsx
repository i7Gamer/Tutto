import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { blockStorage, restoreStorage } from '../testing/storageStubs';
import { clearTurnCaches } from '../utils/diceTurnState';
import { CRASH_LOOP_WINDOW_MS } from '../utils/uiTimings';

const ProblemChild = () => {
  throw new Error("I crashed!");
};

// window.location.reload is non-configurable in jsdom, so the auto-reload
// path cannot be stubbed or observed directly. clearTurnCaches is only ever
// called from clearCacheAndReload, which makes it a faithful witness to
// whether that path ran.
vi.mock('../utils/diceTurnState', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/diceTurnState')>(),
  clearTurnCaches: vi.fn(),
}));

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.mocked(clearTurnCaches).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.clear();
  });

  // Here rather than as the last statement of each test body, which is where
  // it used to live: a failing assertion returns before it, leaking the
  // stubbed fetch into whichever test runs next and turning one red test into
  // a confusing cascade.
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreStorage();

  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>All good here</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('All good here')).toBeInTheDocument();
  });

  it('catches error and displays fallback UI', () => {
    // We mock localStorage so that it simulates a repeated crash, preventing auto-reload
    localStorage.setItem('last_crash_time', Date.now().toString());

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('Oops! Something went wrong.')).toBeInTheDocument();
    expect(screen.getByText('Clear Cache & Reload')).toBeInTheDocument();
  });

  it('shows the fallback instead of auto-reloading when the throttle cannot be stored', () => {
    // Two things at once. componentDidCatch reads and writes the crash
    // throttle while React is already handling a crash, so a throw from there
    // escapes the boundary and the player gets nothing at all. And with
    // storage unavailable the throttle can never persist — auto-reloading on
    // a crash it cannot remember having seen is the reload loop the
    // clearCacheAndReload comment describes, with no fallback UI to land on.
    // So: only auto-reload when the attempt could actually be recorded.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    blockStorage('localStorage');
    blockStorage('sessionStorage');

    expect(() => render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    )).not.toThrow();

    expect(clearTurnCaches).not.toHaveBeenCalled();
    expect(screen.getByText('Oops! Something went wrong.')).toBeInTheDocument();
    // The report still goes out — that path never depended on storage.
    expect(fetch).toHaveBeenCalledWith('/api/log/client-error', expect.anything());
  });

  it('still auto-reloads on a first crash when the throttle can be stored', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );

    expect(clearTurnCaches).toHaveBeenCalled();
    expect(localStorage.getItem('last_crash_time')).not.toBeNull();
  });

  it('records the crash to localStorage and POSTs it to the server', () => {
    // Suppress the auto-reload path so jsdom does not try to reload
    localStorage.setItem('last_crash_time', Date.now().toString());
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );

    const log = JSON.parse(localStorage.getItem('tutto_crash_log') ?? '[]');
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe('I crashed!');
    expect(log[0].stack).toContain('I crashed!');
    expect(log[0].componentStack).toContain('ProblemChild');
    expect(log[0].timestamp).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('/api/log/client-error');
    expect(JSON.parse(options.body).message).toBe('I crashed!');
  });

  it('records the crash even when it triggers the clear-cache-and-reload path', async () => {
    // No last_crash_time → the boundary will clear cache and reload. The crash
    // log entry must survive that cleanup (it only removes specific keys).
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );

    const log = JSON.parse(localStorage.getItem('tutto_crash_log') ?? '[]');
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe('I crashed!');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Adjusted from a synchronous assertion: softRecover now genuinely AWAITS
    // the cache/unregister chain (see clearCachesAndUnregisterWorkers) before
    // reloading — that's the fix for the bug where reload used to fire before
    // the service worker had actually unregistered. Even the trivial
    // no-op/no-caches path now resolves a tick later, so reload is no longer
    // synchronous with render.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('does not loop forever on a persistent crash: a second crash within the throttle window shows the fallback UI instead of reloading again', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    // First crash: no last_crash_time yet, so the auto-reload path runs. The fix
    // is that clearCacheAndReload must NOT clear last_crash_time itself — otherwise
    // a persistent crash (simulated here as "the app crashes again immediately
    // after the reload") would never see a throttle value and would reload forever.
    const { unmount } = render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );
    // See the comment above: softRecover's reload now waits a tick for the
    // (here trivial) cache/unregister chain to settle.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('last_crash_time')).toBeTruthy();
    unmount();

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Oops! Something went wrong.')).toBeInTheDocument();
  });

  describe('the "Clear Cache & Reload" button', () => {
    // The button was rendered by an existing test but never CLICKED, so its
    // whole handler was uncovered — and it did not do what its label says: it
    // unregistered the worker and reloaded, but never touched Cache Storage,
    // unlike Home.tsx's identically-labelled button.
    const clickRecovery = async () => {
      localStorage.setItem('last_crash_time', Date.now().toString());
      render(
        <ErrorBoundary>
          <ProblemChild />
        </ErrorBoundary>
      );
      fireEvent.click(screen.getByText('Clear Cache & Reload'));
      // Let the caches/serviceWorker promise chains settle.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    };

    let reloadMock: ReturnType<typeof vi.fn>;
    let deleteMock: ReturnType<typeof vi.fn>;
    let unregisterMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadMock },
        writable: true,
      });
      deleteMock = vi.fn().mockResolvedValue(true);
      vi.stubGlobal('caches', {
        keys: vi.fn().mockResolvedValue(['tutto-precache-a', 'tutto-precache-b']),
        delete: deleteMock,
      });
      unregisterMock = vi.fn().mockResolvedValue(true);
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister: unregisterMock }]) },
        configurable: true,
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('actually clears Cache Storage, not just the worker registration', async () => {
      await clickRecovery();

      expect(deleteMock).toHaveBeenCalledWith('tutto-precache-a');
      expect(deleteMock).toHaveBeenCalledWith('tutto-precache-b');
    });

    it('unregisters the worker and reloads', async () => {
      await clickRecovery();

      expect(unregisterMock).toHaveBeenCalled();
      expect(reloadMock).toHaveBeenCalled();
    });

    it('resets the crash throttle so the retry is not swallowed', async () => {
      await clickRecovery();

      expect(localStorage.getItem('last_crash_time')).toBeNull();
    });

    it('still reloads when Cache Storage is unavailable (plain http on a LAN)', async () => {
      vi.stubGlobal('caches', undefined);

      await clickRecovery();

      expect(reloadMock).toHaveBeenCalled();
    });
  });

  // A2/A4: the automatic path used to call the same clearCacheAndReload that
  // the manual button did, which wiped tutto_local_game and
  // tutto_online_session on every deploy that happened to break a lazy route
  // chunk — the player did nothing wrong and lost an in-progress game anyway.
  // softRecover keeps both keys; only the explicit "Reset app data" button
  // (below) may remove them.
  describe('automatic first-crash recovery', () => {
    let reloadMock: ReturnType<typeof vi.fn>;
    let deleteMock: ReturnType<typeof vi.fn>;
    let unregisterMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
      reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadMock },
        writable: true,
      });
      deleteMock = vi.fn().mockResolvedValue(true);
      vi.stubGlobal('caches', {
        keys: vi.fn().mockResolvedValue(['tutto-precache-a']),
        delete: deleteMock,
      });
      unregisterMock = vi.fn().mockResolvedValue(true);
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister: unregisterMock }]) },
        configurable: true,
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('keeps the local game and the online session, while still clearing caches, unregistering, and reloading', async () => {
      localStorage.setItem('tutto_local_game', '{"players":["a"]}');
      sessionStorage.setItem('tutto_online_session', '{"roomId":"r1"}');

      render(
        <ErrorBoundary>
          <ProblemChild />
        </ErrorBoundary>
      );
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

      expect(localStorage.getItem('tutto_local_game')).toBe('{"players":["a"]}');
      expect(sessionStorage.getItem('tutto_online_session')).toBe('{"roomId":"r1"}');
      expect(clearTurnCaches).toHaveBeenCalled();
      expect(deleteMock).toHaveBeenCalledWith('tutto-precache-a');
      expect(unregisterMock).toHaveBeenCalled();
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('reloads only after the service worker unregister promise settles', async () => {
      let resolveUnregister: (() => void) | undefined;
      unregisterMock.mockReturnValue(new Promise<void>((resolve) => { resolveUnregister = resolve; }));

      render(
        <ErrorBoundary>
          <ProblemChild />
        </ErrorBoundary>
      );
      // Let the crash log / cache-deletion chain settle, but the unregister
      // promise is still pending.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(unregisterMock).toHaveBeenCalled();
      expect(reloadMock).not.toHaveBeenCalled();

      resolveUnregister?.();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('does not auto-recover a second crash inside the crash-loop window, but does once the window has passed', async () => {
      // Second crash inside the window: last_crash_time is recent, so no
      // reload — the fallback UI is the only thing on screen.
      localStorage.setItem('last_crash_time', Date.now().toString());
      const { unmount } = render(
        <ErrorBoundary>
          <ProblemChild />
        </ErrorBoundary>
      );
      expect(reloadMock).not.toHaveBeenCalled();
      expect(screen.getByText('Oops! Something went wrong.')).toBeInTheDocument();
      unmount();

      // A crash older than the window reads as a "first" crash again.
      localStorage.setItem('last_crash_time', (Date.now() - CRASH_LOOP_WINDOW_MS - 1).toString());
      render(
        <ErrorBoundary>
          <ProblemChild />
        </ErrorBoundary>
      );
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('the "Reset app data" button', () => {
    let reloadMock: ReturnType<typeof vi.fn>;
    let deleteMock: ReturnType<typeof vi.fn>;
    let unregisterMock: ReturnType<typeof vi.fn>;

    const renderCrashed = () => {
      // Throttled so the automatic path does not fire and the fallback UI
      // (with both buttons) is what's on screen for the test to interact with.
      localStorage.setItem('last_crash_time', Date.now().toString());
      render(
        <ErrorBoundary>
          <ProblemChild />
        </ErrorBoundary>
      );
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
      reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadMock },
        writable: true,
      });
      deleteMock = vi.fn().mockResolvedValue(true);
      vi.stubGlobal('caches', {
        keys: vi.fn().mockResolvedValue(['tutto-precache-a']),
        delete: deleteMock,
      });
      unregisterMock = vi.fn().mockResolvedValue(true);
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([{ unregister: unregisterMock }]) },
        configurable: true,
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('asks for confirmation instead of resetting immediately', () => {
      renderCrashed();

      fireEvent.click(screen.getByText('Reset app data'));

      expect(screen.getByText('This also deletes the saved local game and the online session on this device. Continue?')).toBeInTheDocument();
      // ConfirmModal's own labels go through the mocked useTranslation, which
      // returns bare keys in tests (see setupTests.tsx).
      expect(screen.getByText('common.confirm')).toBeInTheDocument();
      expect(screen.getByText('common.cancel')).toBeInTheDocument();
    });

    it('removes both storage keys and reloads once the reset is confirmed', async () => {
      localStorage.setItem('tutto_local_game', '{"players":["a"]}');
      sessionStorage.setItem('tutto_online_session', '{"roomId":"r1"}');
      renderCrashed();

      fireEvent.click(screen.getByText('Reset app data'));
      fireEvent.click(screen.getByText('common.confirm'));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

      expect(localStorage.getItem('tutto_local_game')).toBeNull();
      expect(sessionStorage.getItem('tutto_online_session')).toBeNull();
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('removes nothing and does not reload when the reset is declined', async () => {
      localStorage.setItem('tutto_local_game', '{"players":["a"]}');
      sessionStorage.setItem('tutto_online_session', '{"roomId":"r1"}');
      renderCrashed();

      fireEvent.click(screen.getByText('Reset app data'));
      fireEvent.click(screen.getByText('common.cancel'));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

      expect(localStorage.getItem('tutto_local_game')).toBe('{"players":["a"]}');
      expect(sessionStorage.getItem('tutto_online_session')).toBe('{"roomId":"r1"}');
      expect(reloadMock).not.toHaveBeenCalled();
      expect(screen.queryByText('This also deletes the saved local game and the online session on this device. Continue?')).toBeNull();
    });
  });
});
