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
