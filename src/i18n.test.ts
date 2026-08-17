import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import i18next from 'i18next';
import { resolveLanguage } from './i18n';

/**
 * A fresh page load, as far as i18next is concerned.
 *
 * vi.resetModules() re-evaluates ./i18n but NOT i18next — an externalized
 * dependency, so every test in this file shares one instance of it. Each
 * re-import therefore stacks another 'languageChanged' listener onto it, and
 * the listeners left by earlier tests have already seen their own startup
 * event: they treat this test's init as a user switch and persist a language
 * nobody chose. A real page load evaluates ./i18n once, against one listener.
 */
const resetI18nextListeners = () => i18next.off('languageChanged');

/**
 * Waits for init's own 'languageChanged' to land.
 *
 * i18n.ts calls init() fire-and-forget, and i18next sets `.language`
 * before it emits — so a test that imports the module and reads localStorage
 * straight away is reading it BEFORE the persistence listener has run, and
 * passes whether or not that listener would have written anything. Every
 * assertion about what is or is not stored has to come after this.
 */
const settleLanguageEvents = () => new Promise(resolve => setTimeout(resolve, 0));

// i18n.ts initializes at import time, so each test re-imports a fresh module
// instance against its own localStorage state.
const importFreshI18n = async () => (await import('./i18n')).default;

/**
 * jsdom's navigator.languages is a read-only accessor on the prototype, so it
 * has to be shadowed on the instance and deleted again afterwards — assigning
 * to it silently does nothing and would leave every detection test reading the
 * runner's own locale instead of the staged one.
 */
const stageBrowserLanguages = (languages: readonly string[] | undefined) => {
  if (languages === undefined) {
    Object.defineProperty(navigator, 'languages', { value: [], configurable: true });
    Object.defineProperty(navigator, 'language', { value: '', configurable: true });
    return;
  }
  Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(navigator, 'language', { value: languages[0] ?? '', configurable: true });
};

const restoreBrowserLanguages = () => {
  Reflect.deleteProperty(navigator, 'languages');
  Reflect.deleteProperty(navigator, 'language');
};

describe('resolveLanguage', () => {
  it('takes the first supported language in the browser preference order', () => {
    expect(resolveLanguage(['fr', 'de', 'en'])).toBe('de');
    expect(resolveLanguage(['en', 'de'])).toBe('en');
  });

  // The app ships one German translation, not a regional set, so every German
  // locale resolves to it.
  it('matches on the base tag, ignoring the region', () => {
    expect(resolveLanguage(['de-DE'])).toBe('de');
    expect(resolveLanguage(['de-AT'])).toBe('de');
    expect(resolveLanguage(['en-GB'])).toBe('en');
    expect(resolveLanguage(['DE-de'])).toBe('de');
  });

  it('returns null when nothing on offer is translated', () => {
    expect(resolveLanguage(['fr', 'es-ES'])).toBeNull();
    expect(resolveLanguage([])).toBeNull();
  });

  it('ignores malformed entries rather than matching on them', () => {
    expect(resolveLanguage(['', '-', 'de'])).toBe('de');
  });
});

describe('i18n language persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    resetI18nextListeners();
    localStorage.clear();
    // Neutral by default so the tests below that are not about detection do
    // not depend on the locale the runner happens to be started with.
    stageBrowserLanguages(['en-US']);
  });

  afterEach(restoreBrowserLanguages);

  it('starts in English when no language is stored', async () => {
    const i18n = await importFreshI18n();
    expect(i18n.language).toBe('en');
  });

  // Everyone got English on first load regardless of their browser, and only
  // a trip to the language switcher fixed it.
  it('adopts a translated browser language when nothing is stored', async () => {
    stageBrowserLanguages(['de-DE', 'en-US']);
    const i18n = await importFreshI18n();
    expect(i18n.language).toBe('de');
  });

  it('still lands on English for an untranslated browser language', async () => {
    stageBrowserLanguages(['fr-FR']);
    const i18n = await importFreshI18n();
    expect(i18n.language).toBe('en');
  });

  it('lets a stored choice override the browser language', async () => {
    // The switcher is an explicit decision and outranks detection — otherwise
    // a German browser could never be left on English.
    localStorage.setItem('tutto_language', 'en');
    stageBrowserLanguages(['de-DE']);
    const i18n = await importFreshI18n();
    expect(i18n.language).toBe('en');
  });

  it('does not persist a merely detected language', async () => {
    // Only the switcher writes. Persisting detection would freeze the first
    // browser's locale in place for good, including on a shared device.
    stageBrowserLanguages(['de-DE']);
    const i18n = await importFreshI18n();
    await settleLanguageEvents();

    expect(i18n.language).toBe('de');
    expect(localStorage.getItem('tutto_language')).toBeNull();
  });

  it('does not persist the default language either', async () => {
    // Same rule seen from the other side: arriving on English because nothing
    // matched is not a choice, and storing it would make the next visit skip
    // detection entirely.
    stageBrowserLanguages(['fr-FR']);
    await importFreshI18n();
    await settleLanguageEvents();

    expect(localStorage.getItem('tutto_language')).toBeNull();
  });

  it('survives a browser that exposes no language at all', async () => {
    stageBrowserLanguages(undefined);
    const i18n = await importFreshI18n();
    expect(i18n.language).toBe('en');
  });

  it('restores a stored language choice on startup', async () => {
    localStorage.setItem('tutto_language', 'de');
    const i18n = await importFreshI18n();
    expect(i18n.language).toBe('de');
  });

  it('falls back to English for a corrupted stored value', async () => {
    localStorage.setItem('tutto_language', 'not-a-language');
    const i18n = await importFreshI18n();
    expect(i18n.language).toBe('en');
  });

  it('persists a language change for the next startup', async () => {
    const i18n = await importFreshI18n();
    await settleLanguageEvents();

    await i18n.changeLanguage('de');
    expect(localStorage.getItem('tutto_language')).toBe('de');
  });

  it('persists a switch back to the language it started in', async () => {
    // The startup event is told apart from a real choice partly by storage
    // still being empty, so the return trip has to keep working once it is
    // not — otherwise choosing German, then English, then German again would
    // leave English stored.
    stageBrowserLanguages(['de-DE']);
    const i18n = await importFreshI18n();
    await settleLanguageEvents();

    await i18n.changeLanguage('en');
    expect(localStorage.getItem('tutto_language')).toBe('en');

    await i18n.changeLanguage('de');
    expect(localStorage.getItem('tutto_language')).toBe('de');
  });
});

describe('the document language attribute', () => {
  // index.html ships a hardcoded <html lang="en">. Nothing ever updated it, so
  // a screen reader announced the whole German UI with an English voice and
  // English phoneme rules (WCAG 3.1.1, Level A) — including on a reload, where
  // the stored choice is restored without any user interaction at all.
  beforeEach(() => {
    vi.resetModules();
    resetI18nextListeners();
    localStorage.clear();
    document.documentElement.lang = 'en';
    // Staged for the same reason as above: with browser detection in play, the
    // "starts in English" baseline below is otherwise the runner's own locale.
    stageBrowserLanguages(['en-US']);
  });

  afterEach(restoreBrowserLanguages);

  it('follows the language restored at startup', async () => {
    localStorage.setItem('tutto_language', 'de');
    await importFreshI18n();
    expect(document.documentElement.lang).toBe('de');
  });

  it('follows a language switch', async () => {
    const i18n = await importFreshI18n();
    expect(document.documentElement.lang).toBe('en');

    await i18n.changeLanguage('de');
    expect(document.documentElement.lang).toBe('de');

    await i18n.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
