import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import CardFace from './cards/CardFace';
import type { CardType } from '../../types';

interface CardDisplayProps {
  currentCard: CardType | null;
  cards: CardType[];
}

export default function CardDisplay({ currentCard, cards }: CardDisplayProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center p-2 bg-white/60 dark:bg-slate-800/60 backdrop-blur border border-white/40 rounded-3xl shadow-xl relative overflow-hidden h-full w-full min-h-[300px] md:min-h-[340px]">
      <div className="relative w-[200px] md:w-[220px] lg:w-[240px] h-[280px] md:h-[308px] lg:h-[336px] perspective-[1000px]">
        <AnimatePresence mode="wait">
          {currentCard ? (
            <motion.div
              key={`${currentCard}-${cards.length}`}
              initial={{ rotateY: -90, opacity: 0, scale: 0.8 }}
              animate={{ rotateY: 0, opacity: 1, scale: 1 }}
              exit={{ rotateY: 90, opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.5, type: 'spring', stiffness: 100 }}
              className="absolute w-full h-full rounded-[26px] preserve-3d"
            >
              <CardFace cardType={currentCard} />
            </motion.div>
          ) : (
            <motion.div
              key="no-card"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute w-full h-full border-2 border-dashed border-gray-300 dark:border-slate-500 rounded-2xl flex items-center justify-center bg-black/5 dark:bg-white/5"
            >
              <div className="text-gray-400 font-medium rotate-[-15deg] opacity-70">
                {t('game.noCard', 'No Card')}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
