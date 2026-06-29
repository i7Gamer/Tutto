import { useTranslation } from 'react-i18next';

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const currentLanguage = i18n.language || 'en';

  return (
    <div className="flex gap-2 bg-black/5 dark:bg-white/5 p-1 rounded-lg backdrop-blur border border-gray-200 dark:border-slate-600">
      <button
        onClick={() => void i18n.changeLanguage('en')}
        className={`px-3 py-1 rounded-md text-sm font-bold transition-all ${currentLanguage.startsWith('en') ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
      >
        EN
      </button>
      <button
        onClick={() => void i18n.changeLanguage('de')}
        className={`px-3 py-1 rounded-md text-sm font-bold transition-all ${currentLanguage.startsWith('de') ? 'bg-white dark:bg-slate-700 shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'}`}
      >
        DE
      </button>
    </div>
  );
}
