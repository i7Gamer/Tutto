import { useTranslation } from 'react-i18next';
import { Check, Layers } from 'lucide-react';
import { motion } from 'framer-motion';
import { isTestEnv } from '../../utils/env';
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
  // Classic chains: offered next to the bank button after a tutto. While the
  // choice is up there is deliberately NO countdown (see the render below and
  // DiceGame's useAutoContinueCountdown wiring) — it is a strategic decision,
  // bounded online by the room's turn timer, whose expiry forfeits the turn
  // like any other timeout.
  onDrawNextCard?: () => void;
  // Whether this summary's score is a classic chain total being banked. A
  // separate question from "may another card be drawn on it?" above: past
  // MAX_CHAIN_CARDS the chain can only bank, and both the points line and the
  // button still have to say so. Answering both with onDrawNextCard meant the
  // banked total vanished at the cap and the button offered to continue to the
  // next player instead of naming what it was banking.
  banksChainTotal?: boolean;
}

export default function DiceSummary({ summaryData, continueCountdown, finishGame, currentCard, onDrawNextCard, banksChainTotal = false }: DiceSummaryProps) {
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
            <strong className="text-indigo-600 font-black">{summaryData.score}</strong>
          </p>
        )}

      {/* Both a success and a bust auto-continue to the next player after a short
          countdown — only the colour differs (green for a win, red for a bust).
          The button lets the player skip the wait and continue immediately.
          While the classic bank-or-draw choice is on screen there is no
          countdown: the decision is the player's, bounded by the turn timer. */}
      <div className="mt-10 flex flex-col items-center gap-3">
        {!onDrawNextCard && (
          <>
            <p className={`font-semibold text-lg ${summaryData.won ? 'text-emerald-500' : 'text-red-400'}`}>
              {t('dice.auto_continuing', 'Continuing in {{count}}…', { count: continueCountdown ?? 0 })}
            </p>
            <div className={`w-full rounded-full h-2 overflow-hidden ${summaryData.won ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
              <motion.div
                className={`h-2 rounded-full ${summaryData.won ? 'bg-emerald-500' : 'bg-red-500'}`}
                initial={{ width: '100%' }}
                animate={{ width: '0%' }}
                transition={{ duration: isTestEnv() ? 0 : AUTO_CONTINUE_SECONDS, ease: 'linear' }}
              />
            </div>
          </>
        )}
        <button
          className="mt-2 bg-indigo-600 hover:bg-indigo-700 text-white w-full py-3 rounded-xl text-lg font-bold flex justify-center items-center gap-2 shadow-lg shadow-indigo-500/30 transition-all"
          onClick={finishGame}
        >
          {banksChainTotal
            ? t('dice.bank_points', 'Bank {{score}} points', { score: summaryData.score })
            : t('dice.continue', 'Continue to Next Player')} <Check size={22} />
        </button>
        {onDrawNextCard && (
          <button
            data-testid="draw-next-card"
            className="bg-amber-500 hover:bg-amber-600 text-white w-full py-3 rounded-xl text-lg font-bold flex justify-center items-center gap-2 shadow-lg shadow-amber-500/30 transition-all"
            onClick={onDrawNextCard}
          >
            {t('dice.draw_next_card', 'Draw next card — risk everything!')} <Layers size={22} />
          </button>
        )}
      </div>
    </motion.div>
  );
}
