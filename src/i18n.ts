import { localStore } from './utils/storage';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import translationEN from './locales/en/translation.json';
import translationDE from './locales/de/translation.json';

const resources = {
  en: { translation: translationEN },
  de: { translation: translationDE },
};

// The user's explicit choice from LanguageSwitcher — persisted so it survives
// a reload like every other preference (theme, diceMode, audio, haptics).
const LANGUAGE_STORAGE_KEY = 'tutto_language';

const isSupportedLanguage = (v: unknown): v is keyof typeof resources =>
  typeof v === 'string' && v in resources;

const storedLanguage = localStore.read(LANGUAGE_STORAGE_KEY);

void i18n.use(initReactI18next).init({
  resources,
  lng: isSupportedLanguage(storedLanguage) ? storedLanguage : 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

/**
 * Keeps <html lang> in step with the UI language.
 *
 * index.html ships a hardcoded lang="en" and nothing ever updated it, so a
 * screen reader announced the entire German UI with an English voice and
 * English phoneme rules (WCAG 3.1.1, Level A). Guarded because i18n.ts is also
 * imported by node-environment tests, which have no document.
 */
const applyDocumentLanguage = (lng: string): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lng;
};

// Registered after init so only an actual switch (LanguageSwitcher) writes —
// the initial language is either the stored value itself or the default,
// neither of which needs re-persisting.
i18n.on('languageChanged', (lng) => {
  localStore.write(LANGUAGE_STORAGE_KEY, lng);
  applyDocumentLanguage(lng);
});

// The restored language never fires 'languageChanged' (init adopts it
// directly), so the reload path — the one that needs no user interaction at
// all — would otherwise keep the hardcoded "en" from index.html.
applyDocumentLanguage(i18n.language);

export default i18n;
