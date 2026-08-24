/**
 * The stale-bundle recovery handler in index.html.
 *
 * It is an inline <script> deliberately — it has to run before main.tsx and
 * before any React error boundary exists, so it cannot be a module the app
 * imports. That also means nothing else in the suite covers it. This file
 * reads the real index.html, pulls the inline script out, and evaluates it
 * with addEventListener stubbed so the registered handler can be invoked
 * directly (rather than dispatching events into a window that accumulates a
 * fresh listener for every test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const RELOAD_KEY = 'tutto_last_reload';
const CHUNK_ERROR_MESSAGE = 'Failed to fetch dynamically imported module: /assets/index-abc123.js';
const EXPECTED_INLINE_SCRIPTS = 1;

type ErrorHandler = (e: { message?: string; target?: unknown }) => void;

/** The one inline <script> in index.html — the module tag carries a src. */
const readInlineScript = (): string => {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const inline = Array.from(doc.querySelectorAll('script')).filter(
    script => !script.hasAttribute('src')
  );
  if (inline.length !== EXPECTED_INLINE_SCRIPTS) {
    throw new Error(
      `index.html should have ${EXPECTED_INLINE_SCRIPTS} inline <script>, found ${inline.length}`
    );
  }
  return inline[0].textContent ?? '';
};

const inlineScript = readInlineScript();

/** Evaluates the inline script and returns the 'error' listener it registers. */
const loadHandler = (): ErrorHandler => {
  let captured: ErrorHandler | undefined;
  const addEventListener = vi
    .spyOn(window, 'addEventListener')
    .mockImplementation((type: string, cb: unknown) => {
      if (type === 'error') captured = cb as ErrorHandler;
    });
  try {
    new Function(inlineScript)();
  } finally {
    addEventListener.mockRestore();
  }
  if (!captured) throw new Error('index.html script registered no error listener');
  return captured;
};

const reload = vi.fn();
const cacheDelete = vi.fn(async () => true);
const unregister = vi.fn(async () => true);

const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
};

/** Lets the handler's caches → unregister → reload promise chain settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('index.html stale-bundle recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    reload.mockClear();
    cacheDelete.mockClear();
    unregister.mockClear();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    vi.stubGlobal('caches', { keys: vi.fn(async () => ['precache-v1']), delete: cacheDelete });
    Object.defineProperty(window, 'location', {
      value: { reload, href: 'https://tutto.example/' },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistrations: async () => [{ unregister }] },
      configurable: true,
    });
    setOnline(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('wipes the cache, unregisters the worker and reloads on a chunk error', async () => {
    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(cacheDelete).toHaveBeenCalledWith('precache-v1');
    expect(unregister).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  // The whole point of the precache is offline play, and offline is exactly
  // when a chunk fetch fails. Recovering there deletes the caches and
  // unregisters the worker with no network to refill either — turning a
  // recoverable miss into an app that cannot start until it is back online.
  // The 60s throttle does not help: one pass is all the damage there is.
  it('leaves the cache and the worker alone while the device is offline', async () => {
    setOnline(false);

    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(cacheDelete).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  // Going offline must not burn the one attempt the cooldown allows, or
  // coming back online would find a fresh timestamp and skip the recovery.
  it('does not spend the reload cooldown on an offline error', async () => {
    setOnline(false);
    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(localStorage.getItem(RELOAD_KEY)).toBeNull();

    setOnline(true);
    loadHandler()({ message: CHUNK_ERROR_MESSAGE });
    await settle();

    expect(reload).toHaveBeenCalled();
  });

  it('still ignores an unrelated third-party script error', async () => {
    loadHandler()({ target: { tagName: 'SCRIPT', src: 'https://cdn.example/analytics.js' } });
    await settle();

    expect(reload).not.toHaveBeenCalled();
  });
});
