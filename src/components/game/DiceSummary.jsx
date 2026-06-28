import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import { isTestEnv } from '../../utils/env';

export default function DiceSummary({ summaryData, bustState, bustCountdown, finishGame, currentCard }) {
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
        !['Kniffel', 'Plus_Minus', 'Kleeblatt'].includes(currentCard) &&
        summaryData.score > 0 && (
          <p className="text-2xl text-gray-700 dark:text-gray-200">
            {t('dice.points_gained', 'Points gained: ')}
            <strong className="text-indigo-600 font-black">{summaryData.score}</strong>
          </p>
        )}

      {bustState && !summaryData.won ? (
        <div className="mt-10 flex flex-col items-center gap-3">
          <p className="text-red-400 font-semibold text-lg">
            {t('dice.auto_continuing', 'Continuing in {{count}}…', { count: bustCountdown ?? 0 })}
          </p>
          <div className="w-full bg-red-100 dark:bg-red-900/30 rounded-full h-2 overflow-hidden">
            <motion.div
              className="h-2 bg-red-500 rounded-full"
              initial={{ width: '100%' }}
              animate={{ width: '0%' }}
              transition={{ duration: isTestEnv() ? 0 : 3, ease: 'linear' }}
            />
          </div>
        </div>
      ) : (
        <button
          className="mt-10 bg-indigo-600 hover:bg-indigo-700 text-white w-full py-4 rounded-xl text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-indigo-500/30 transition-all"
          onClick={finishGame}
        >
          {t('dice.continue', 'Continue to Next Player')} <Check size={24} />
        </button>
      )}
    </motion.div>
  );
}
