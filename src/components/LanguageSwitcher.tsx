import { useTranslation } from 'react-i18next';

export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language || 'en';

  return (
    <div className="flex gap-2 bg-black/5 dark:bg-white/5 p-1 rounded-lg backdrop-blur-sm border border-gray-200 dark:border-slate-600">
      {/* min-h-11 min-w-11 grow the tap target to the 44px WCAG minimum
          (MIN_TAP_TARGET_PX, e2e/styling.spec.ts) — these were ~28px tall.
          -my-2 gives the added height back as negative margin so this
          switcher's own footprint (and the fixed HUD strip it sits in,
          App.tsx) doesn't grow with it; growing that would have pushed the
          HUD into content the A9 tests already check it clears. */}
      <button
        onClick={() => void i18n.changeLanguage('en')}
        aria-label={t('app.switchToEnglish', 'Switch to English')}
        aria-pressed={currentLanguage.startsWith('en')}
        className={`px-3 py-1 rounded-md text-sm font-bold transition-all min-h-11 min-w-11 flex items-center justify-center -my-2 ${currentLanguage.startsWith('en') ? 'bg-white dark:bg-slate-700 shadow-xs text-indigo-600 dark:text-indigo-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
      >
        EN
      </button>
      <button
        onClick={() => void i18n.changeLanguage('de')}
        aria-label={t('app.switchToGerman', 'Switch to German')}
        aria-pressed={currentLanguage.startsWith('de')}
        className={`px-3 py-1 rounded-md text-sm font-bold transition-all min-h-11 min-w-11 flex items-center justify-center -my-2 ${currentLanguage.startsWith('de') ? 'bg-white dark:bg-slate-700 shadow-xs text-indigo-600 dark:text-indigo-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
      >
        DE
      </button>
    </div>
  );
}
