import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';

const CARD_IMAGE_MAP = {
  "200": "200.png",
  "300": "300.png",
  "400": "400.png",
  "500": "500.png",
  "600": "600.png",
  "x2": "x2.png",
  "Feuerwerk": "Feuerwerk.png",
  "Stop": "Stop.png",
  "Kleeblatt": "Kleeblatt.png",
  "Plus_Minus": "plusminus.png",
  "Kniffel": "Kniffel.png",
  "fallback": "logo.png"
};

export default function CardDisplay({ currentCard, cards }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center p-2 bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-3xl shadow-xl relative overflow-hidden h-full w-full min-h-[300px] md:min-h-[340px]">
      
      <div className="relative w-[180px] md:w-[200px] lg:w-[220px] h-[280px] md:h-[310px] lg:h-[340px] perspective-[1000px]">
        <AnimatePresence mode="wait">
          {currentCard ? (
            <motion.div
              key={`${currentCard}-${cards ? cards.length : 0}`}
              initial={{ rotateY: -90, opacity: 0, scale: 0.8 }}
              animate={{ rotateY: 0, opacity: 1, scale: 1 }}
              exit={{ rotateY: 90, opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.5, type: "spring", stiffness: 100 }}
              className="absolute w-full h-full shadow-2xl rounded-2xl overflow-hidden preserve-3d"
            >
              <img 
                src={`./assets/${CARD_IMAGE_MAP[currentCard] ?? CARD_IMAGE_MAP['fallback']}`} 
                alt={t(`game.cards.${currentCard}`, currentCard)} 
                className="w-full h-full object-cover"
              />
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
