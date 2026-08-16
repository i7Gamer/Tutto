import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import type { CardType } from '../../types';

interface TurnScoreHeaderProps {
  turnScore: number;
  // What the selection on the table would add to the running total — computed
  // by the dice panel, which owns the validation it depends on.
  pendingSelectionScore: number;
  isClassic: boolean;
  chainCardCount: number;
  currentCard: CardType | null;
  tuttosThisTurn: number;
}

export default function TurnScoreHeader({ turnScore, pendingSelectionScore, isClassic, chainCardCount, currentCard, tuttosThisTurn }: TurnScoreHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="text-center mb-6 sm:mb-8">
      <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">{t('dice.current_score', 'Current Score')}</div>
      {/* Keyed by turnScore alone (not the live selection) so the pop
          animation plays when a roll is banked, not on every die
          click that flips the selection valid/invalid. */}
      <motion.div key={turnScore} data-testid="dice-current-score" initial={{ scale: 1.2 }} animate={{ scale: 1 }} className="text-5xl font-black text-indigo-600 dark:text-indigo-400">
        {turnScore + pendingSelectionScore}
      </motion.div>
      {isClassic && chainCardCount > 1 && (
        <div className="text-indigo-500 mt-2 font-bold text-sm bg-indigo-50 dark:bg-indigo-900/30 inline-block px-4 py-1 rounded-full border border-indigo-200 dark:border-indigo-800">
          {t('dice.chain_card_count', 'Card {{count}} of this turn', { count: chainCardCount })}
        </div>
      )}
      {currentCard === 'Kleeblatt' && (
        <div className="text-emerald-500 mt-2 font-bold text-lg bg-emerald-50 inline-block px-4 py-1 rounded-full border border-emerald-200">
          {t('dice.tuttos_count', 'Tuttos: {{count}} / 2', { count: tuttosThisTurn })}
        </div>
      )}
    </div>
  );
}
