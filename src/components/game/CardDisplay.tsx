import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import CardFace from './cards/CardFace';
import { STOP_CARD_AUTO_CONTINUE_SECONDS } from '../../utils/uiTimings';
import type { CardType } from '../../types';

interface CardDisplayProps {
  currentCard: CardType | null;
  cards: CardType[];
  /**
   * Seconds left before an online Stop card advances the turn on its own —
   * null (or omitted) whenever that auto-continue isn't armed (offline, not
   * this player's turn, or the dice panel is open). See
   * useStopCardAutoContinue, which is the only source of this value.
   */
  stopCardCountdown?: number | null;
}

export default function CardDisplay({ currentCard, cards, stopCardCountdown = null }: CardDisplayProps) {
  const { t } = useTranslation();

  return (
    // role="status" so a mid-game flip is ANNOUNCED, not merely inspectable:
    // CardFace names the card, but a screen-reader user with focus elsewhere
    // has no reason to go and read it, and the card decides the scoring rule
    // for the whole turn. polite, because the flip is never urgent.
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center p-2 bg-white/60 dark:bg-slate-800/60 sm:backdrop-blur-sm border border-white/40 rounded-3xl shadow-xl relative overflow-hidden h-full w-full min-h-[300px] md:min-h-[340px]"
    >
      <div className="relative w-[200px] md:w-[220px] lg:w-[240px] h-[280px] md:h-[308px] lg:h-[336px] perspective-[1000px]">
        <AnimatePresence mode="wait">
          {currentCard ? (
            <motion.div
              key={`${currentCard}-${cards.length}`}
              initial={{ rotateY: -90, opacity: 0, scale: 0.8 }}
              animate={{ rotateY: 0, opacity: 1, scale: 1 }}
              exit={{ rotateY: 90, opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.5, type: 'spring', stiffness: 100 }}
              className="absolute w-full h-full rounded-[26px] transform-3d"
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

      {/* Mirrors the dice summary's own "Continuing in N…" cue (DiceSummary.tsx)
          — an online Stop card used to advance the turn with no warning at
          all. aria-hidden: the flip itself is what role="status" above
          announces, and re-announcing this region on every one-second tick
          would be the opposite of polite. */}
      {stopCardCountdown !== null && (
        <div aria-hidden="true" className="mt-3 flex flex-col items-center gap-2 w-full max-w-[240px]">
          <p className="font-semibold text-sm text-red-400">
            {t('dice.auto_continuing', 'Continuing in {{count}}…', { count: stopCardCountdown })}
          </p>
          <div className="w-full rounded-full h-2 overflow-hidden bg-red-100 dark:bg-red-900/30">
            {/* Keyed on cards.length (not the ticking countdown itself), so
                the drain plays once over the whole duration like the dice
                summary's bar — restarting only for a genuine second Stop
                draw, not on every one-second re-render. */}
            <motion.div
              key={cards.length}
              className="h-2 rounded-full bg-red-500"
              initial={{ width: '100%' }}
              animate={{ width: '0%' }}
              transition={{ duration: STOP_CARD_AUTO_CONTINUE_SECONDS, ease: 'linear' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
