/**
 * The pre-paint theme-setting inline <script> in index.html's <head>.
 *
 * It has to run before src/index.css even parses, let alone before App.tsx's
 * own theme effect (which only fires after the first successful render) —
 * so it cannot be app code, and nothing else in the suite covers it. This
 * file reads the real index.html, pulls the <head> inline script out (see
 * src/indexHtmlRecovery.test.ts for the sibling <body> script and why the
 * two are scoped separately), and evaluates it directly against jsdom's
 * real `document` and `localStorage` so it can assert on the resulting
 * data-theme attribute.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const STORAGE_KEY = 'tutto-theme';
const EXPECTED_HEAD_INLINE_SCRIPTS = 1;

/** The one inline <script> in a page's <head> — everything else there carries no logic. */
const parseHeadInlineScript = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const inline = Array.from(doc.head.querySelectorAll('script')).filter(
    script => !script.hasAttribute('src')
  );
  if (inline.length !== EXPECTED_HEAD_INLINE_SCRIPTS) {
    throw new Error(
      `index.html <head> should have ${EXPECTED_HEAD_INLINE_SCRIPTS} inline <script>, found ${inline.length}`
    );
  }
  return inline[0].textContent ?? '';
};

const readThemeScript = (): string =>
  parseHeadInlineScript(fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8'));

const themeScript = readThemeScript();

/** Runs the real script against jsdom's document/localStorage/matchMedia. */
const runThemeScript = (): void => {
  new Function(themeScript)();
};

const setPrefersDark = (prefersDark: boolean): void => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

describe('index.html pre-paint theme script', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    setPrefersDark(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies a stored dark choice', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    setPrefersDark(false);

    runThemeScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies a stored light choice', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    setPrefersDark(true);

    runThemeScript();

    // The stored choice wins even against a conflicting OS preference — see
    // themePreference.ts's own rule, which this mirrors.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('falls back to a dark OS preference when nothing is stored', () => {
    setPrefersDark(true);

    runThemeScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to a light OS preference when nothing is stored', () => {
    setPrefersDark(false);

    runThemeScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  // A privacy mode, a full quota, or a policy can make every localStorage
  // call throw rather than merely return null — the same failure mode
  // indexHtmlRecovery.test.ts guards against for the sibling script. The
  // script must still resolve a theme from the OS preference rather than
  // letting the throw abort before data-theme is ever set.
  it('falls back to the OS preference when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });
    setPrefersDark(true);

    runThemeScript();

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
