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

/**
 * The first language in `candidates` this app is actually translated into, or
 * null if it speaks none of them.
 *
 * Matched on the BASE tag: the app ships one German translation, not a
 * regional set, so de-DE, de-AT and de all resolve to the same resources. The
 * candidate order is the browser's own preference order, so a reader who
 * ranks French above German but has neither... gets English, correctly.
 */
export const resolveLanguage = (candidates: readonly string[]): keyof typeof resources | null => {
  for (const tag of candidates) {
    const base = tag.split('-')[0].toLowerCase();
    if (isSupportedLanguage(base)) return base;
  }
  return null;
};

// `navigator.languages` is the ranked list and the one to prefer;
// `navigator.language` is the single fallback for anything that lacks it.
// Guarded because i18n.ts is imported by node-environment tests too, and
// older runtimes have no navigator at all.
const browserLanguages = (): readonly string[] => {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
};

const storedLanguage = localStore.read(LANGUAGE_STORAGE_KEY);

// An explicit choice in the switcher outranks the browser — otherwise a German
// browser could never be left on English. Only when there is no stored choice
// does detection get a say; before it did not, so every first load was English
// and the only way out was finding the switcher.
const initialLanguage = isSupportedLanguage(storedLanguage)
  ? storedLanguage
  : resolveLanguage(browserLanguages()) ?? 'en';

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
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

// Registered after init, which is what keeps the startup language out of
// storage: init adopts `lng` without emitting 'languageChanged' to a listener
// attached afterwards, so only an actual switch (LanguageSwitcher) ever writes
// here. That mattered little while the startup language could only be the
// already-stored value or the 'en' default — with detection it matters a lot,
// because persisting a merely DETECTED language would freeze the first
// browser's locale in place as though the reader had chosen it, on a shared
// device too, leaving the switcher as the only way back.
i18n.on('languageChanged', (lng) => {
  localStore.write(LANGUAGE_STORAGE_KEY, lng);
  applyDocumentLanguage(lng);
});

// Applied synchronously too: init's event lands a tick later, and until it
// does the reload path — the one that needs no user interaction at all —
// would keep the hardcoded "en" from index.html.
applyDocumentLanguage(i18n.language);

export default i18n;
