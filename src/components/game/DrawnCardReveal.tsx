import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import CardFace from './cards/CardFace';
import type { CardType } from '../../types';

interface DrawnCardRevealProps {
  card: CardType;
  // Which card of the chain this is, and the accumulated total it now puts at
  // risk — the dice panel covers the board, so this is the only place the
  // player sees either.
  chainCardCount: number;
  turnScore: number;
  onContinue: () => void;
}

/**
 * The card just drawn mid-chain, shown before play resumes on it.
 *
 * The draw is decided in the dice panel's own button row now, so nothing else
 * would ever show the player what they drew: the board behind is hidden by the
 * dice modal, and the next thing to happen is a fresh roll judged by this
 * card's rules.
 */
export default function DrawnCardReveal({ card, chainCardCount, turnScore, onContinue }: DrawnCardRevealProps) {
  const { t } = useTranslation();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center text-center py-4"
    >
      <h2 className="text-2xl font-extrabold text-gray-800 dark:text-gray-100 mb-1">
        {t('dice.drawn_card_title', 'You drew:')}
      </h2>
      <p className="text-sm font-bold text-indigo-500 uppercase tracking-wider mb-5">
        {t('dice.chain_card_count', 'Card {{count}} of this turn', { count: chainCardCount })}
      </p>

      <div className="relative w-[200px] md:w-[220px] h-[280px] md:h-[308px] perspective-[1000px] mb-6">
        <motion.div
          initial={{ rotateY: -90, opacity: 0, scale: 0.8 }}
          animate={{ rotateY: 0, opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, type: 'spring', stiffness: 100 }}
          className="absolute w-full h-full rounded-[26px] transform-3d"
        >
          <CardFace cardType={card} />
        </motion.div>
      </div>

      <p className="text-lg text-gray-700 dark:text-gray-200 mb-6">
        {t('dice.points_at_risk', 'At risk: ')}
        <strong className="text-indigo-600 dark:text-indigo-400 font-black">{turnScore}</strong>
      </p>

      <button
        data-testid="drawn-card-continue"
        className="bg-indigo-600 hover:bg-indigo-700 text-white w-full max-w-sm py-3 rounded-xl text-lg font-bold flex justify-center items-center gap-2 shadow-lg shadow-indigo-500/30 transition-all"
        onClick={onContinue}
      >
        {t('dice.drawn_card_continue', 'Continue')} <ChevronRight size={22} />
      </button>
    </motion.div>
  );
}
