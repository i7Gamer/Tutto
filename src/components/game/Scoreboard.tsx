import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { GameStore } from '../../store/useGameStore';

interface ScoreboardProps {
  game: GameStore;
  formattedTime: string;
}

export default function Scoreboard({ game, formattedTime }: ScoreboardProps) {
  const { t } = useTranslation();
  const {
    players,
    currentPlayerIndex,
    isOnline,
    myName,
    round,
    winningScore,
    turnTimeRemaining,
  } = game;

  const currentPlayer = currentPlayerIndex !== null && players?.length ? players[currentPlayerIndex] : null;
  const isMyTurn = !isOnline || (currentPlayer && currentPlayer.name === myName);

  let displayPlayer = currentPlayer;
  if (isOnline) {
    displayPlayer = players?.find(p => p.name === myName) ?? currentPlayer;
  }
  const displayScore = displayPlayer ? displayPlayer.score : 0;

  const scoreProgress = winningScore ? Math.min((displayScore / winningScore) * 100, 100) : 0;
  const roundProgress = players?.length && currentPlayerIndex !== null ? (currentPlayerIndex / players.length) * 100 : 0;

  const isTurnTimerUrgent = turnTimeRemaining !== null && turnTimeRemaining <= 10;

  if (!currentPlayer) return null;

  return (
    <div className="flex flex-col gap-2 md:gap-4 w-full phone-landscape:flex-row phone-landscape:flex-wrap">
      <div className="flex gap-2 md:gap-4 w-full phone-landscape:contents">
        <motion.div layout className="flex-1 min-w-[100px] md:min-w-[120px] phone-landscape:min-w-[75px] bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-xl md:rounded-2xl p-2 md:p-4 shadow-sm flex flex-col justify-center items-center">
          <div className="text-[10px] md:text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-0.5 md:mb-1">{t('game.currentPlayer', 'Current Player')}</div>
          <div className="text-lg md:text-2xl font-extrabold truncate w-full text-center flex flex-col items-center gap-1" style={{ color: currentPlayer.color || '#4f46e5' }}>
            <span className="flex items-center justify-center gap-2">
              {isOnline && game.hostId === currentPlayer.socketId && <span title={t('game.host', 'Host')} className="text-xl leading-none">👑</span>}
              {isOnline && isMyTurn ? t('game.you', 'You ({{name}})', { name: currentPlayer.name }) : currentPlayer.name}
            </span>
            {currentPlayer.disconnected && <span className="text-red-500 text-[10px] md:text-xs font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50 leading-tight">{t('game.disconnected', 'Disconnected')}</span>}
          </div>
        </motion.div>

        <motion.div layout className="flex-1 min-w-[100px] md:min-w-[120px] phone-landscape:min-w-[75px] bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-xl md:rounded-2xl p-2 md:p-4 shadow-sm flex flex-col justify-center items-center relative overflow-hidden">
          <motion.div className="absolute bottom-0 left-0 w-full bg-emerald-500/15" initial={{ height: 0 }} animate={{ height: `${scoreProgress}%` }} transition={{ type: 'spring', stiffness: 50 }} />
          <div className="text-[10px] md:text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-0.5 md:mb-1 z-10">{isOnline ? t('game.yourScore', 'Your Score') : t('game.score', 'Score')}</div>
          <div className="text-xl md:text-3xl font-black text-gray-800 dark:text-gray-100 z-10">{displayScore}</div>
        </motion.div>
      </div>

      <div className="flex flex-wrap gap-2 md:gap-4 w-full phone-landscape:contents">
        <motion.div layout className="flex-1 min-w-[100px] md:min-w-[120px] phone-landscape:min-w-[75px] bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-xl md:rounded-2xl p-2 md:p-4 shadow-sm flex flex-col justify-center items-center relative overflow-hidden">
          <motion.div className="absolute bottom-0 left-0 w-full bg-indigo-500/15" animate={{ height: `${roundProgress}%` }} transition={{ type: 'spring', stiffness: 50 }} />
          <div className="text-[10px] md:text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-0.5 md:mb-1 z-10">{t('game.round', 'Round')}</div>
          <div className="text-xl md:text-3xl font-black text-gray-800 dark:text-gray-100 z-10">{round}</div>
        </motion.div>

        <AnimatePresence>
          {turnTimeRemaining !== null && turnTimeRemaining !== undefined && (
            <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} className={`flex-1 min-w-[100px] md:min-w-[120px] phone-landscape:min-w-[75px] backdrop-blur border rounded-xl md:rounded-2xl p-2 md:p-4 shadow-sm flex flex-col justify-center items-center transition-colors ${isTurnTimerUrgent ? 'bg-red-50/90 border-red-200' : 'bg-white dark:bg-slate-800/80 border-white/40'}`}>
              <div className={`text-[10px] md:text-sm font-bold uppercase tracking-wider mb-0.5 md:mb-1 ${isTurnTimerUrgent ? 'text-red-600' : 'text-gray-500 dark:text-gray-400'}`}>{t('game.turnTimer', 'Turn Timer')}</div>
              <motion.div key={turnTimeRemaining} initial={{ scale: 1.2 }} animate={{ scale: 1 }} className={`text-lg md:text-3xl font-black ${isTurnTimerUrgent ? 'text-red-600' : 'text-gray-800 dark:text-gray-100'}`}>
                {t('game.timeSeconds', '{{time}}s', { time: turnTimeRemaining })}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div layout className="flex-1 min-w-[100px] md:min-w-[120px] phone-landscape:min-w-[75px] bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-xl md:rounded-2xl p-2 md:p-4 shadow-sm flex flex-col justify-center items-center">
          <div className="text-[10px] md:text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-0.5 md:mb-1">{t('game.time', 'Time')}</div>
          <div className="text-lg md:text-2xl font-bold text-gray-800 dark:text-gray-100 font-mono tracking-tighter">{formattedTime}</div>
        </motion.div>
      </div>
    </div>
  );
}
