import { Download, Share, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useInstallPrompt } from '../hooks/useInstallPrompt';

const ICON_SIZE = 22;
const BUTTON_ICON_SIZE = 16;
const DISMISS_ICON_SIZE = 18;

/**
 * The dismissible "Add to Home Screen" card mounted above Home.tsx's
 * clear-cache line. Tailwind classes only — every colour utility below
 * carries its `dark:` twin. No live region: nothing here needs to interrupt
 * a screen reader, and the card sits on screen until dismissed or acted on.
 */
export default function InstallPrompt() {
  const { t } = useTranslation();
  const { state, install, dismiss } = useInstallPrompt();

  if (state === 'hidden') return null;

  return (
    <div
      role="region"
      aria-label={t('installPrompt.regionLabel')}
      className="mt-6 flex items-start gap-3 rounded-2xl border border-indigo-100 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 p-4"
    >
      <div className="shrink-0 mt-0.5 text-indigo-600 dark:text-indigo-400">
        {state === 'native' ? <Download size={ICON_SIZE} /> : <Share size={ICON_SIZE} />}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-gray-800 dark:text-gray-100">
          {t('installPrompt.title')}
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-0.5">
          {state === 'native' ? t('installPrompt.nativeBody') : t('installPrompt.iosBody')}
        </p>

        {state === 'native' && (
          <button
            onClick={install}
            className="mt-3 inline-flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm px-4 py-2 transition-colors cursor-pointer"
          >
            <Download size={BUTTON_ICON_SIZE} /> {t('installPrompt.installButton')}
          </button>
        )}
      </div>

      <button
        onClick={dismiss}
        aria-label={t('installPrompt.dismissLabel')}
        className="shrink-0 min-h-11 min-w-11 flex items-center justify-center text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 cursor-pointer"
      >
        <X size={DISMISS_ICON_SIZE} />
      </button>
    </div>
  );
}
