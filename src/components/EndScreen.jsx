import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { RotateCcw, Trophy, Settings } from 'lucide-react';
import { motion } from 'framer-motion';
import { useGameStore } from '../store/useGameStore';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const colors = [
  '#FF5733', '#33FF57', '#3357FF', '#F033FF', '#33FFF0',
  '#FFD700', '#FF33A1', '#8D33FF', '#33FF8D', '#FF8D33'
];

export default function EndScreen({ theme, deviceId }) {
  const { t } = useTranslation();
  const game = useGameStore();
  const { 
    players,
    round, 
    gameTimeInSeconds,
    startGame, 
    endGame,
    chartLabels,
    chartNames,
    chartValues,
    leaveRoom,
    isOnline,
    isHost
  } = game;

  const [sortedPlayers] = useState(() => players.map(p => ({...p})).sort((a, b) => b.score - a.score));
  const winner = sortedPlayers[0];
  
  const formatTime = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  };
  const formattedTime = formatTime(gameTimeInSeconds);

  const [deviceStats, setDeviceStats] = useState(null);

  useEffect(() => {
    let isMounted = true;
    let timerId = null;

    const fetchStats = async (retries = 0) => {
      if (!isMounted) return;
      try {
        const res = await fetch(`/api/stats/${deviceId}`);
        const data = await res.json();
        
        if ((!data || !data.gamesPlayed) && retries < 5) {
          timerId = setTimeout(() => fetchStats(retries + 1), 1000);
          return;
        }
        
        if (isMounted) setDeviceStats(data);
      } catch (err) {
        console.error("Could not fetch device stats", err);
        if (retries < 5 && isMounted) {
          timerId = setTimeout(() => fetchStats(retries + 1), 1000);
        }
      }
    };

    if (deviceId) {
      timerId = setTimeout(() => fetchStats(0), 500);
    }

    return () => {
      isMounted = false;
      if (timerId) clearTimeout(timerId);
    };
  }, [deviceId]);

  if (!winner) return null;

  const textColor = theme === 'dark' ? '#f8fafc' : '#1a1a1a';
  const gridColor = theme === 'dark' ? '#334155' : '#e5e7eb';

  const chartData = {
    labels: chartLabels,
    datasets: chartNames.map((name, i) => ({
      label: name,
      data: chartValues[i],
      borderColor: colors[i % colors.length],
      backgroundColor: colors[i % colors.length],
      tension: 0.2
    }))
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top', labels: { color: textColor } },
      title: { display: true, text: t('end.scorePerRound', 'Score per Round'), color: textColor },
    },
    scales: {
      y: { ticks: { color: textColor }, grid: { color: gridColor } },
      x: { ticks: { color: textColor }, grid: { color: gridColor } }
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl flex flex-col gap-8">
      <motion.div 
        initial={{ opacity: 0, y: 20, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-2xl rounded-3xl p-10 text-center"
      >
        <motion.div 
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', damping: 10, stiffness: 100, delay: 0.2 }}
          className="flex justify-center mb-6"
        >
          <div className="bg-amber-100 p-6 rounded-full shadow-lg border-4 border-amber-300">
            <Trophy size={64} className="text-amber-500" />
          </div>
        </motion.div>
        
        <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-amber-500 to-orange-600 mb-8">
          {t('end.winner', 'Winner:')} {winner.name}
        </h1>
        
        <div className="flex flex-wrap justify-center gap-6 mb-10">
          <div className="bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-slate-600 rounded-2xl p-6 min-w-[180px] shadow-sm">
            <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{t('end.playedRounds', 'Played Rounds')}</div>
            <div className="text-4xl font-black text-indigo-600">{round}</div>
          </div>
          <div className="bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-slate-600 rounded-2xl p-6 min-w-[180px] shadow-sm">
            <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{t('end.playtime', 'Playtime')}</div>
            <div className="text-4xl font-black text-indigo-600">{formattedTime}</div>
          </div>
        </div>

        <div className="flex justify-center">
          {(!game.isOnline || game.isHost) ? (
            <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white py-4 px-6 rounded-2xl text-xl font-bold flex justify-center items-center gap-2 shadow-lg shadow-emerald-500/30 transition-colors" 
                onClick={startGame}
              >
                <RotateCcw size={24} /> {t('end.playAgain', 'Play Again')}
              </motion.button>
              <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="flex-1 bg-white dark:bg-slate-800 hover:bg-black/5 dark:bg-white/5 text-gray-700 dark:text-gray-200 border-2 border-gray-200 dark:border-slate-600 py-4 px-6 rounded-2xl text-lg font-bold flex justify-center items-center gap-2 shadow-sm transition-colors" 
                onClick={endGame}
              >
                <Settings size={20} /> {t('end.newConfig', 'New Config')}
              </motion.button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 bg-black/5 dark:bg-white/5 p-6 rounded-2xl border border-gray-200 dark:border-slate-600 w-full max-w-md">
              <div className="text-indigo-600 font-bold text-lg flex items-center gap-3">
                <div className="w-6 h-6 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                {t('end.waitingForHost', 'Waiting for host to restart...')}
              </div>
              <button 
                className="text-red-500 hover:text-red-700 hover:bg-red-50 px-6 py-2 rounded-lg font-bold transition-colors border border-red-200" 
                onClick={leaveRoom}
              >
                {t('end.leaveGame', 'Leave Game')}
              </button>
            </div>
          )}
        </div>
      </motion.div>

      {deviceStats && deviceStats.gamesPlayed > 0 && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl p-8"
        >
          <h3 className="text-2xl font-bold text-gray-800 dark:text-gray-100 text-center mb-8">{t('end.lifetimeStats', 'Your Lifetime Statistics')}</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center mb-8">
            <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-100">
              <div className="text-4xl font-black text-indigo-600 mb-1">{deviceStats.gamesPlayed}</div>
              <div className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('end.gamesPlayed', 'Games Played')}</div>
            </div>
            <div className="bg-emerald-50 rounded-2xl p-4 border border-emerald-100">
              <div className="text-4xl font-black text-emerald-500 mb-1">{deviceStats.wins}</div>
              <div className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('end.totalWins', 'Total Wins')}</div>
            </div>
            <div className="bg-red-50 rounded-2xl p-4 border border-red-100">
              <div className="text-4xl font-black text-red-500 mb-1">{deviceStats.pointsDeducted}</div>
              <div className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('end.pointsEaten', '-1000 Pts Eaten')}</div>
            </div>
            <div className="bg-amber-50 rounded-2xl p-4 border border-amber-100">
              <div className="text-4xl font-black text-amber-500 mb-1">{deviceStats.kniffelCompleted}</div>
              <div className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('end.kniffelsDone', 'Kniffels Done')}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-6 text-center max-w-md mx-auto">
            <div className="bg-orange-50 rounded-2xl p-4 border border-orange-100">
              <div className="text-4xl font-black text-orange-500 mb-1">{deviceStats.busts || 0}</div>
              <div className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('end.totalBusts', 'Total Busts')}</div>
            </div>
            <div className="bg-orange-50 rounded-2xl p-4 border border-orange-100">
              <div className="text-4xl font-black text-orange-500 mb-1">{((deviceStats.busts || 0) / Math.max(1, deviceStats.gamesPlayed)).toFixed(1)}</div>
              <div className="text-sm font-semibold text-gray-500 dark:text-gray-400">{t('end.avgBustsPerGame', 'Avg Busts/Game')}</div>
            </div>
          </div>
        </motion.div>
      )}

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl p-8 overflow-hidden"
      >
        <h3 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-6">{t('end.gameStats', 'Game Statistics')}</h3>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-slate-600">
          <div className="flex flex-col rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 min-w-max">
            <div className="flex border-b border-gray-200 dark:border-slate-600 bg-black/5 dark:bg-white/5">
              <div className="p-4 w-56 flex-shrink-0 font-bold text-gray-600 dark:text-gray-300">{t('end.stat', 'Stat')}</div>
              {sortedPlayers.map(p => (
                <div key={p.name} className="p-4 w-32 flex-shrink-0 font-bold text-center" style={{ color: p.color || 'var(--text-color, #4f46e5)' }}>{p.name}</div>
              ))}
            </div>
            <div className="flex flex-col">
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.position', 'Position')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 font-bold text-center">{p.position}.</div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.score', 'Score')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 font-black text-indigo-600 text-center">{p.score}</div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.totalTurns', 'Total Turns')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 text-center">{p.totalTurns}</div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.busts', 'Busts')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 text-red-500 font-bold text-center">{p.busts}</div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.avgPtsPerRound', 'Avg Pts / Round')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 font-bold text-emerald-500 text-center">{Math.round(p.score / Math.max(1, round))}</div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.pointsEatenStat', '-1000 Points Eaten')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 text-center">{p.times1000PointsDeducted}</div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.plusMinusStat', 'Plus/Minus (Success/Fail)')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 text-center"><span className="text-emerald-500">{p.timesPlusMinusCompleted}</span> / <span className="text-red-500">{p.timesPlusMinusFailed}</span></div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.kniffelStat', 'Kniffel (Success/Fail)')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 text-center"><span className="text-emerald-500">{p.timesKniffelCompleted}</span> / <span className="text-red-500">{p.timesKniffelFailed}</span></div>)}
              </div>
              <div className="flex border-b border-gray-100 dark:border-slate-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.skipped', 'Skipped')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 text-center">{p.timesSkipped}</div>)}
              </div>
              <div className="flex hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div className="p-4 w-56 flex-shrink-0 font-medium text-gray-600 dark:text-gray-300">{t('end.feuerwerkStat', 'Feuerwerk (Received/Pts)')}</div>
                {sortedPlayers.map(p => <div key={p.name} className="p-4 w-32 flex-shrink-0 text-center">{p.timesFeuerwerkReceived} / <span className="text-amber-500 font-bold">{p.feuerwerkPointsScored || 0}</span></div>)}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {chartLabels && chartLabels.length > 0 && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl p-8 h-[400px]"
        >
          <Line data={chartData} options={chartOptions} />
        </motion.div>
      )}
    </div>
  );
}
