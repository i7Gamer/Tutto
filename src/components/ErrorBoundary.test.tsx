import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { blockStorage, restoreStorage } from '../testing/storageStubs';
import { clearTurnCaches } from '../utils/diceTurnState';

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

  it('records the crash even when it triggers the clear-cache-and-reload path', () => {
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
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('does not loop forever on a persistent crash: a second crash within the throttle window shows the fallback UI instead of reloading again', () => {
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
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('last_crash_time')).toBeTruthy();
    unmount();

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Oops! Something went wrong.')).toBeInTheDocument();
  });
});
