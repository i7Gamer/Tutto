import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

const ProblemChild = () => {
  throw new Error("I crashed!");
};

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.clear();
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

    vi.unstubAllGlobals();
  });

  it('records the crash even when it triggers the clear-cache-and-reload path', () => {
    // No last_crash_time → the boundary will clear cache and reload. The crash
    // log entry must survive that cleanup (it only removes specific keys).
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
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
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

    vi.unstubAllGlobals();
  });
});
