import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '../../store/useGameStore';
import type { HistoryEntry } from '../../types';
import { CARD_EMOJIS, UNKNOWN_CARD_EMOJI } from '../../utils/cardVisuals';

export default function HistoryLog() {
  const { t } = useTranslation();
  const historyLog = useGameStore(state => state.historyLog) || [];

  const getCardName = (cardType: string) => {
    if (/^\d+$/.test(cardType)) {
      return cardType;
    }
    let key = cardType;
    if (cardType === 'Plus_Minus') key = 'plusMinus';
    else if (cardType === 'Feuerwerk') key = 'feuerwerk';
    else if (cardType === 'Kleeblatt') key = 'kleeblatt';
    else if (cardType === 'Kniffel') key = 'kniffel';
    else if (cardType === 'Stop') key = 'stop';
    else if (cardType === 'x2') key = 'x2';

    const cardKey = `cards.${key}`;
    return t(cardKey, cardType);
  };

  const getLogMessage = (entry: HistoryEntry) => {
    const cardName = getCardName(entry.card);
    const name = entry.playerName;

    // A classic chain shows every card of the turn, in draw order.
    if (entry.cards && entry.cards.length > 1) {
      const chain = entry.cards.map(getCardName).join(' → ');
      if (entry.type === 'success') {
        // A completed Kleeblatt is a binary instant win, so the engine records
        // the turn as worth 0 (see calculateNextTurn) — printing that score
        // read the game-winning turn as "scored 0 pts".
        if (entry.cards[entry.cards.length - 1] === 'Kleeblatt') {
          return t('history.chainKleeblatt', { name, chain, defaultValue: `${name} completed Kleeblatt and won! (${chain})` });
        }
        return t('history.chainSuccess', { name, score: entry.score, chain, defaultValue: `${name} scored ${entry.score} pts (${chain})` });
      }
      return t('history.chainBust', { name, chain, defaultValue: `${name} lost everything (${chain})` });
    }

    if (entry.type === 'skip') {
      return t('history.skip', { name, defaultValue: `${name} skipped (Stop)` });
    }
    if (entry.type === 'bust') {
      return t('history.bust', { name, card: cardName, defaultValue: `${name} busted on ${cardName}` });
    }
    if (entry.type === 'fail') {
      return t('history.fail', { name, card: cardName, defaultValue: `${name} failed ${cardName}` });
    }
    if (entry.type === 'success') {
      if (entry.card === 'Kleeblatt') {
        return t('history.kleeblatt', { name, defaultValue: `${name} completed Kleeblatt and won!` });
      }
      if (entry.card === 'Plus_Minus' && entry.deductedPlayers && entry.deductedPlayers.length > 0) {
        const deducted = entry.deductedPlayers.join(', ');
        return t('history.plusMinusDeducted', { name, deducted, defaultValue: `${name} scored 1000 pts (${deducted} lost 1000)` });
      }
      return t('history.success', { name, score: entry.score, card: cardName, defaultValue: `${name} scored ${entry.score} pts on ${cardName}` });
    }
    return '';
  };

  return (
    <div className="bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-3xl p-4 md:p-6 shadow-xl flex flex-col h-full">
      <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 uppercase tracking-wider text-center">
        {t('history.title', 'Activity Log')}
      </h3>
      <div className="flex-1 flex flex-col min-h-0 bg-white dark:bg-slate-800/40 rounded-xl border border-gray-100 dark:border-slate-700 overflow-hidden">
        <div className="flex px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-slate-700 bg-black/5 dark:bg-white/5">
          <div className="w-12 text-center">{t('game.pos', 'Rnd')}</div>
          <div className="flex-1 px-2">{t('game.player', 'Event')}</div>
        </div>
        <div className="flex-1 overflow-y-auto max-h-[300px] scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-slate-700 p-1">
          <AnimatePresence initial={false}>
            {historyLog.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="px-4 py-8 text-center text-gray-400 dark:text-gray-500 font-medium"
              >
                {t('history.empty', 'No turns taken yet.')}
              </motion.div>
            ) : (
              [...historyLog].reverse().map((entry) => {
                const emoji = CARD_EMOJIS[entry.card] || UNKNOWN_CARD_EMOJI;
                return (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, y: -12, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: 'auto' }}
                    exit={{ opacity: 0, y: -12, height: 0 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                    className="flex items-center px-4 py-3 border-b border-gray-50 dark:border-slate-700/50 last:border-0 hover:bg-black/5 dark:hover:bg-white/5 transition-colors overflow-hidden"
                  >
                    <div className="w-12 flex justify-center">
                      <span className="text-[11px] font-bold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-slate-700 px-2 py-0.5 rounded-full whitespace-nowrap">
                        R{entry.round}
                      </span>
                    </div>
                    <div className="flex-1 px-2 flex items-center gap-2 flex-wrap min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: entry.playerColor || '#6366f1' }}
                      />
                      <span className="text-lg leading-none" title={entry.card}>
                        {emoji}
                      </span>
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-200 break-words max-w-full">
                        {getLogMessage(entry)}
                      </span>
                    </div>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
