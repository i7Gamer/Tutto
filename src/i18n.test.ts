import { describe, it, expect, beforeEach, vi } from 'vitest';

// i18n.ts initializes at import time, so each test re-imports a fresh module
// instance against its own localStorage state.
const importFreshI18n = async () => (await import('./i18n')).default;

describe('i18n language persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('starts in English when no language is stored', async () => {
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
    localStorage.clear();
    document.documentElement.lang = 'en';
  });

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
