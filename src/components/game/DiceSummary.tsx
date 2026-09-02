import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import { isSpecialCard } from '../../utils/diceTurnControls';
import { AUTO_CONTINUE_SECONDS } from '../../utils/uiTimings';
import type { CardType } from '../../types';

interface SummaryData {
  won: boolean;
  score: number;
  isTutto?: boolean;
  stoppedByCard?: boolean;
}

interface DiceSummaryProps {
  summaryData: SummaryData;
  continueCountdown: number | null;
  finishGame: () => void;
  currentCard: CardType | null;
  // Whether this summary's score is a classic chain total that was banked —
  // what the points line and the button call it. Drawing another card instead
  // is decided before any of this, in the dice panel's own button row.
  banksChainTotal?: boolean;
}

export default function DiceSummary({ summaryData, continueCountdown, finishGame, currentCard, banksChainTotal = false }: DiceSummaryProps) {
  const { t } = useTranslation();

  // Focus has to be caught here or it is lost. This panel replaces the dice
  // table, so whatever held focus — a die, Roll, Stop & Score — unmounts at
  // this moment and focus falls to <body>. ModalShell's Tab trap is a handler
  // ON THE PANEL, so from body it never sees a key and Tab walks the page
  // behind the backdrop instead. Continue is also exactly what the panel's
  // Space/Enter shortcut already triggers, so taking focus here cannot make a
  // keypress do something it could not do a moment ago.
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    continueRef.current?.focus();
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="text-center py-10"
    >
      <h2 className={`text-4xl font-extrabold mb-4 ${summaryData.won ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
        {summaryData.won ? t('dice.success', 'Success!') : t('dice.bust', 'Bust!')}
      </h2>
      {summaryData.isTutto && (
        <h3 className="text-3xl font-bold text-indigo-500 mb-4 animate-bounce">
          {t('dice.tutto', 'Tutto!')}
        </h3>
      )}
      {summaryData.stoppedByCard && (
        <p className="text-xl font-bold text-red-500 bg-red-50 dark:bg-red-900/20 inline-block px-4 py-2 rounded-xl border border-red-100 dark:border-red-900/50">
          {t('dice.stop_card_drawn', 'Stop card! All points from this turn are lost.')}
        </p>
      )}
      {/* A special card's own score is the fixed value the engine awards, not
          anything this panel knows — so it stays hidden for one, unless the
          score IS a classic chain total being banked. */}
      {(summaryData.won || currentCard === 'Feuerwerk') &&
        (!isSpecialCard(currentCard) || banksChainTotal) &&
        summaryData.score > 0 && (
          <p className="text-2xl text-gray-700 dark:text-gray-200">
            {t('dice.points_gained', 'Points gained: ')}
            <strong className="accent-number font-black">{summaryData.score}</strong>
          </p>
        )}

      {/* Both a success and a bust auto-continue to the next player after a short
          countdown — only the colour differs (green for a win, red for a bust).
          The button lets the player skip the wait and continue immediately. */}
      <div className="mt-10 flex flex-col items-center gap-3">
        <p className={`font-semibold text-lg ${summaryData.won ? 'text-emerald-500' : 'text-red-400'}`}>
          {t('dice.auto_continuing', 'Continuing in {{count}}…', { count: continueCountdown ?? 0 })}
        </p>
        <div className={`w-full rounded-full h-2 overflow-hidden ${summaryData.won ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
          <motion.div
            className={`h-2 rounded-full ${summaryData.won ? 'bg-emerald-500' : 'bg-red-500'}`}
            initial={{ width: '100%' }}
            animate={{ width: '0%' }}
            transition={{ duration: AUTO_CONTINUE_SECONDS, ease: 'linear' }}
          />
        </div>
        <button
          ref={continueRef}
          data-testid="dice-summary-continue"
          className="mt-2 bg-indigo-600 hover:bg-indigo-700 text-white w-full py-3 rounded-xl text-lg font-bold flex justify-center items-center gap-2 shadow-lg shadow-indigo-500/30 transition-all"
          onClick={finishGame}
        >
          {banksChainTotal
            ? t('dice.bank_points', 'Bank {{score}} points', { score: summaryData.score })
            : t('dice.continue', 'Continue to Next Player')} <Check size={22} />
        </button>
      </div>
    </motion.div>
  );
}
