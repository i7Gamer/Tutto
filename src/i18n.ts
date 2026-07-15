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

const storedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);

void i18n.use(initReactI18next).init({
  resources,
  lng: isSupportedLanguage(storedLanguage) ? storedLanguage : 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

// Registered after init so only an actual switch (LanguageSwitcher) writes —
// the initial language is either the stored value itself or the default,
// neither of which needs re-persisting.
i18n.on('languageChanged', (lng) => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
});

export default i18n;
