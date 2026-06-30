import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { isTestEnv } from '../../utils/env';
import type { CardType } from '../../types';

interface SummaryData {
  won: boolean;
  score: number;
  isTutto?: boolean;
}

interface DiceSummaryProps {
  summaryData: SummaryData;
  bustCountdown: number | null;
  currentCard: CardType | null;
}

export default function DiceSummary({ summaryData, bustCountdown, currentCard }: DiceSummaryProps) {
  const { t } = useTranslation();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="text-center py-10"
    >
      <h2 className={`text-4xl font-extrabold mb-4 ${summaryData.won ? 'text-emerald-500' : 'text-red-500'}`}>
        {summaryData.won ? t('dice.success', 'Success!') : t('dice.bust', 'Bust!')}
      </h2>
      {summaryData.isTutto && (
        <h3 className="text-3xl font-bold text-indigo-500 mb-4 animate-bounce">
          {t('dice.tutto', 'Tutto!')}
        </h3>
      )}
      {(summaryData.won || currentCard === 'Feuerwerk') &&
        !(['Kniffel', 'Plus_Minus', 'Kleeblatt'] as string[]).includes(currentCard ?? '') &&
        summaryData.score > 0 && (
          <p className="text-2xl text-gray-700 dark:text-gray-200">
            {t('dice.points_gained', 'Points gained: ')}
            <strong className="text-indigo-600 font-black">{summaryData.score}</strong>
          </p>
        )}

      {/* Both a success and a bust auto-continue to the next player after a short
          countdown — only the colour differs (green for a win, red for a bust). */}
      <div className="mt-10 flex flex-col items-center gap-3">
        <p className={`font-semibold text-lg ${summaryData.won ? 'text-emerald-500' : 'text-red-400'}`}>
          {t('dice.auto_continuing', 'Continuing in {{count}}…', { count: bustCountdown ?? 0 })}
        </p>
        <div className={`w-full rounded-full h-2 overflow-hidden ${summaryData.won ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
          <motion.div
            className={`h-2 rounded-full ${summaryData.won ? 'bg-emerald-500' : 'bg-red-500'}`}
            initial={{ width: '100%' }}
            animate={{ width: '0%' }}
            transition={{ duration: isTestEnv() ? 0 : 3, ease: 'linear' }}
          />
        </div>
      </div>
    </motion.div>
  );
}
