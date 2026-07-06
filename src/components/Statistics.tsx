import { useState, useEffect } from 'react';
import { Trophy, Clock, Hash, FastForward, BarChart2, Globe, User, TrendingDown, TrendingUp, Zap, Repeat, Skull, XCircle, ArrowLeft } from 'lucide-react';
import { formatTime } from '../utils/formatTime';
import { parseJsonObject } from '../utils/parseJson';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import React from 'react';

interface PersonalStats {
  gamesPlayed: number;
  wins: number;
  totalPlaytime: number;
  busts?: number;
  totalTurns?: number;
  totalScore?: number;
  pointsDeducted?: number;
  plusMinusCompleted?: number;
  plusMinusFailed?: number;
  kniffelCompleted?: number;
  kniffelFailed?: number;
  kleeblattCompleted?: number;
  kleeblattFailed?: number;
  skipped?: number;
  feuerwerkReceived?: number;
  feuerwerkBusts?: number;
  feuerwerkPointsScored?: number;
  x2Received?: number;
  x2Busts?: number;
  x2PointsScored?: number;
  highestTurnScore?: number;
  fastestWinTurns?: number | null;
  fastestLossTurns?: number | null;
  currentWinStreak?: number;
  bestWinStreak?: number;
}

interface GlobalStats {
  totalGamesPlayed: number;
  totalPlaytime: number;
  totalTurns?: number;
  totalScore?: number;
  totalBusts?: number;
  totalPlusMinus?: number;
  totalPlusMinusCompleted?: number;
  totalKniffel?: number;
  totalKniffelCompleted?: number;
  totalKleeblatt?: number;
  totalKleeblattCompleted?: number;
  totalStop?: number;
  totalFeuerwerk?: number;
  totalFeuerwerkBusts?: number;
  totalFeuerwerkPoints?: number;
  totalx2?: number;
  totalx2Busts?: number;
  totalx2Points?: number;
  highestTurnScore?: number;
  fastestWinTurns?: number | null;
}

const getWinLoseRate = (wins: number, fails: number): string => {
  const total = wins + fails;
  if (total === 0) return '—';
  return `${((wins / total) * 100).toFixed(0)}%`;
};

interface StatTileProps {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  colorClass?: string;
  bgClass?: string;
}

const StatTile = ({ icon, value, label, colorClass = 'text-indigo-600 dark:text-indigo-400', bgClass = 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-500/30' }: StatTileProps) => (
  <div className={`p-6 rounded-2xl border relative text-left overflow-hidden shadow-sm ${bgClass}`}>
    <div className="absolute top-4 right-4 opacity-50">{icon}</div>
    <div className={`text-3xl font-black mt-2 ${colorClass}`}>{value}</div>
    <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-1 pr-8">{label}</div>
  </div>
);

interface BigStatTileProps {
  value: React.ReactNode;
  label: string;
  colorClass?: string;
  bgClass?: string;
}

const BigStatTile = ({ value, label, colorClass = 'text-indigo-600 dark:text-indigo-400', bgClass = 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-500/30' }: BigStatTileProps) => (
  <div className={`p-8 rounded-2xl border text-center shadow-sm ${bgClass}`}>
    <div className={`text-5xl font-black mb-2 ${colorClass}`}>{value}</div>
    <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{label}</div>
  </div>
);

interface CardRowProps {
  label: string;
  icon: React.ReactNode;
  count: number;
  wins?: number;
  fails?: number;
  avgPoints?: number;
  hideRate?: boolean;
  failsLabel?: string;
}

const CardRow = ({ label, icon, count, wins, fails, avgPoints, hideRate, failsLabel }: CardRowProps) => {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="flex items-center justify-between p-4 rounded-2xl bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 shadow-sm mb-3 hover:shadow-md transition-shadow"
    >
      <div className="flex items-center gap-3 flex-1">
        <span className="text-2xl">{icon}</span>
        <span className="font-bold text-gray-800 dark:text-gray-100">{label}</span>
      </div>
      <div className="flex items-center gap-6">
        <div className="text-center min-w-[40px]">
          <div className="font-black text-lg text-gray-700 dark:text-gray-200">{count}</div>
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{t('statistics.total', 'Total')}</div>
        </div>
        {wins !== undefined && (
          <>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-emerald-500 dark:text-emerald-400">{wins}</div>
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{t('statistics.won', 'Won')}</div>
            </div>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-red-500 dark:text-red-400">{fails}</div>
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{failsLabel || t('statistics.lost', 'Lost')}</div>
            </div>
            {!hideRate && (
              <div className="text-center min-w-[50px]">
                <div className="font-black text-lg text-indigo-600 dark:text-indigo-400">{getWinLoseRate(wins, fails ?? 0)}</div>
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{t('statistics.rate', 'Rate')}</div>
              </div>
            )}
          </>
        )}
        {avgPoints !== undefined && (
          <div className="text-center min-w-[50px]">
            <div className="font-black text-lg text-amber-500 dark:text-amber-400">{count > 0 ? Math.round(avgPoints / count) : 0}</div>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{t('statistics.avgPts', 'Avg Pts')}</div>
          </div>
        )}
      </div>
    </motion.div>
  );
};

interface StatisticsProps {
  deviceId: string;
  onBack: () => void;
}

export default function Statistics({ deviceId, onBack }: StatisticsProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'personal' | 'global'>('personal');
  const [personalStats, setPersonalStats] = useState<PersonalStats | null>(null);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const [personalRes, globalRes] = await Promise.all([
          fetch(`/api/stats/${deviceId}`),
          fetch('/api/stats/global'),
        ]);
        if (personalRes.ok) setPersonalStats(await parseJsonObject<PersonalStats>(personalRes));
        if (globalRes.ok) setGlobalStats(await parseJsonObject<GlobalStats>(globalRes));
      } catch (err) {
        console.error('Failed to load statistics:', err);
      } finally {
        setLoading(false);
      }
    };
    void fetchStats();
  }, [deviceId]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-full min-h-[500px]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
          <h2 className="text-xl font-bold text-gray-700 dark:text-gray-200">{t('statistics.loading', 'Loading Statistics...')}</h2>
        </div>
      </div>
    );
  }

  const p = personalStats;
  const g = globalStats;

  const pWinRate = p?.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(0) : '0';
  const pAvgDuration = p?.gamesPlayed ? p.totalPlaytime / p.gamesPlayed : 0;
  const pBustRate = p?.totalTurns ? (((p.busts ?? 0) / p.totalTurns) * 100).toFixed(0) : '0';
  const gAvgDuration = g?.totalGamesPlayed ? g.totalPlaytime / g.totalGamesPlayed : 0;
  const gBustRate = g?.totalTurns ? (((g.totalBusts ?? 0) / g.totalTurns) * 100).toFixed(0) : '0';

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl flex flex-col items-center">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-2xl rounded-3xl p-8 relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />
        <div className="flex items-center mb-8 relative justify-center">
          <button className="absolute left-0 p-3 bg-white dark:bg-slate-800 hover:bg-black/5 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-600 dark:text-gray-300 transition-colors shadow-sm" onClick={onBack} aria-label={t('common.back', 'Back')}>
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-3xl font-extrabold text-gray-800 dark:text-gray-100 flex items-center gap-3 m-0">
            <BarChart2 size={36} className="text-indigo-600" /> {t('statistics.title', 'Statistics')}
          </h1>
        </div>

        <div className="flex gap-4 mb-10 justify-center" role="tablist">
          <motion.button role="tab" aria-selected={tab === 'personal'} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold transition-all ${tab === 'personal' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-black/5 border border-gray-200 dark:border-slate-600'}`}
            onClick={() => setTab('personal')}
          >
            <User size={18} /> {t('statistics.personal', 'Personal')}
          </motion.button>
          <motion.button role="tab" aria-selected={tab === 'global'} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold transition-all ${tab === 'global' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-black/5 border border-gray-200 dark:border-slate-600'}`}
            onClick={() => setTab('global')}
          >
            <Globe size={18} /> {t('statistics.globalCommunity', 'Global Community')}
          </motion.button>
        </div>

        <AnimatePresence mode="wait">
          {tab === 'personal' && (
            <motion.div key="personal" role="tabpanel" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="flex flex-col w-full">
              <h3 className="text-xl font-bold mb-6 text-center text-gray-700 dark:text-gray-200">{t('statistics.onlineLifetimeRecord', 'Online Lifetime Record (This Device)')}</h3>
              {!p || !p.gamesPlayed ? (
                <div className="text-center text-gray-500 dark:text-gray-400 py-10 bg-black/5 dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-slate-700">
                  <div className="text-4xl mb-4">🎮</div>
                  {t('statistics.noPersonalGames', "You haven't played any online games on this device yet!")}
                </div>
              ) : (
                <div className="w-full">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <BigStatTile value={p.gamesPlayed} label={t('statistics.gamesPlayed', 'Games Played')} />
                    <BigStatTile value={p.wins} label={t('statistics.gamesWon', 'Games Won')} colorClass="text-emerald-500 dark:text-emerald-400" bgClass="bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-500/30" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Trophy size={32} className="text-amber-500" />} value={`${pWinRate}%`} label={t('statistics.winRate', 'Win Rate')} colorClass="text-amber-600 dark:text-amber-400" bgClass="bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-500/30" />
                    <StatTile icon={<Clock size={32} className="text-indigo-400" />} value={formatTime(pAvgDuration)} label={t('statistics.avgDuration', 'Avg Duration')} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile 
                      icon={<Zap size={32} className={`text-amber-500 ${(p.currentWinStreak || 0) >= 3 ? 'animate-pulse' : ''}`} />} 
                      value={(p.currentWinStreak || 0) >= 3 ? `🔥 ${p.currentWinStreak}` : (p.currentWinStreak || 0)} 
                      label={t('statistics.currentWinStreak', 'Current Win Streak')} 
                      colorClass={(p.currentWinStreak || 0) >= 3 ? 'text-amber-600 dark:text-amber-400 font-extrabold' : 'text-amber-600 dark:text-amber-400'} 
                      bgClass={(p.currentWinStreak || 0) >= 3 ? 'bg-amber-100/70 dark:bg-amber-900/40 border-amber-200 dark:border-amber-500/50 shadow-sm animate-pulse' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-500/30'} 
                    />
                    <StatTile 
                      icon={<Trophy size={32} className="text-amber-500" />} 
                      value={p.bestWinStreak || 0} 
                      label={t('statistics.bestWinStreak', 'Best Win Streak')} 
                      colorClass="text-amber-600 dark:text-amber-400" 
                      bgClass="bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-500/30" 
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${pBustRate}%`} label={t('statistics.bustRate', 'Bust Rate')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                    <StatTile icon={<XCircle size={32} className="text-red-400" />} value={p.pointsDeducted || 0} label={t('statistics.ptsEaten', '-1000 Pts Eaten')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Repeat size={32} className="text-gray-400" />} value={p.totalTurns || 0} label={t('statistics.totalTurns', 'Total Turns')} colorClass="text-gray-700 dark:text-gray-200" bgClass="bg-black/5 dark:bg-white/5 border-gray-200 dark:border-slate-600" />
                    <StatTile icon={<Clock size={32} className="text-gray-400" />} value={formatTime(p.totalPlaytime)} label={t('statistics.totalPlaytime', 'Total Playtime')} colorClass="text-gray-700 dark:text-gray-200" bgClass="bg-black/5 dark:bg-white/5 border-gray-200 dark:border-slate-600" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={p.busts || 0} label={t('statistics.totalBusts', 'Total Busts')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={p.gamesPlayed ? Math.round((p.busts || 0) / p.gamesPlayed) : 0} label={t('statistics.avgBustsPerGame', 'Avg Busts / Game')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={p.highestTurnScore || 0} label={t('statistics.highestTurn', 'Highest Turn')} colorClass="text-yellow-600 dark:text-yellow-400" bgClass="bg-yellow-50 dark:bg-yellow-900/20 border-yellow-100 dark:border-yellow-500/30" />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={p.totalTurns ? Math.round((p.totalScore || 0) / p.totalTurns) : 0} label={t('statistics.avgPointsPerTurn', 'Avg Points/Turn')} />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={p.fastestWinTurns || '-'} label={t('statistics.fastestWinTurns', 'Fastest Win (Turns)')} colorClass="text-green-600 dark:text-green-400" bgClass="bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-500/30" />
                    <StatTile icon={<Skull size={32} className="text-red-400" />} value={p.fastestLossTurns || '-'} label={t('statistics.fastestLossTurns', 'Fastest Loss (Turns)')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>
                  <h4 className="text-lg font-extrabold text-gray-800 dark:text-gray-100 border-t border-gray-200 dark:border-slate-600 pt-8 pb-6 text-center uppercase tracking-widest flex items-center justify-center gap-3">
                    <span className="text-2xl">🃏</span> {t('statistics.cardBreakdown', 'Card Breakdown')}
                  </h4>
                  <div className="max-w-2xl mx-auto flex flex-col gap-1">
                    <CardRow label={t('cards.plusMinus', 'Plus/Minus')} icon="±" count={(p.plusMinusCompleted || 0) + (p.plusMinusFailed || 0)} wins={p.plusMinusCompleted || 0} fails={p.plusMinusFailed || 0} />
                    <CardRow label={t('cards.kniffel', 'Kniffel')} icon="🎲" count={(p.kniffelCompleted || 0) + (p.kniffelFailed || 0)} wins={p.kniffelCompleted || 0} fails={p.kniffelFailed || 0} />
                    <CardRow label={t('cards.kleeblatt', 'Kleeblatt')} icon="🍀" count={(p.kleeblattCompleted || 0) + (p.kleeblattFailed || 0)} wins={p.kleeblattCompleted || 0} fails={p.kleeblattFailed || 0} />
                    <CardRow label={t('cards.stop', 'Stop')} icon="🛑" count={p.skipped || 0} />
                    <CardRow label={t('cards.feuerwerk', 'Feuerwerk')} icon="🎆" count={p.feuerwerkReceived || 0} wins={(p.feuerwerkReceived || 0) - (p.feuerwerkBusts || 0)} fails={p.feuerwerkBusts || 0} failsLabel={t('statistics.busts', 'Busts')} hideRate avgPoints={p.feuerwerkPointsScored || 0} />
                    <CardRow label={t('cards.x2', 'x2')} icon="✖️" count={p.x2Received || 0} wins={(p.x2Received || 0) - (p.x2Busts || 0)} fails={p.x2Busts || 0} failsLabel={t('statistics.busts', 'Busts')} hideRate avgPoints={p.x2PointsScored || 0} />
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {tab === 'global' && (
            <motion.div key="global" role="tabpanel" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex flex-col w-full">
              <div className="text-center mb-8">
                <h3 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-2">{t('statistics.globalCommunityTitle', 'Global Community Statistics')}</h3>
                <p className="text-gray-500 dark:text-gray-400 font-medium">{t('statistics.globalDescription', 'Aggregated across all online games played.')}</p>
              </div>
              {!g || !g.totalGamesPlayed ? (
                <div className="text-center text-gray-500 dark:text-gray-400 py-10 bg-black/5 dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-slate-700">
                  <div className="text-4xl mb-4">🌍</div>
                  {t('statistics.noGlobalGames', 'No games have been played on the server yet!')}
                </div>
              ) : (
                <div className="w-full">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <BigStatTile value={g.totalGamesPlayed} label={t('statistics.totalGames', 'Total Games')} />
                    <BigStatTile value={formatTime(g.totalPlaytime)} label={t('statistics.totalPlaytime', 'Total Playtime')} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Clock size={32} className="text-emerald-400" />} value={formatTime(gAvgDuration)} label={t('statistics.avgGameDuration', 'Avg Game Duration')} colorClass="text-emerald-600 dark:text-emerald-400" bgClass="bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-500/30" />
                    <StatTile icon={<Zap size={32} className="text-indigo-400" />} value={g.totalScore || 0} label={t('statistics.totalPointsScored', 'Total Points Scored')} />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Repeat size={32} className="text-gray-400" />} value={g.totalTurns || 0} label={t('statistics.totalTurnsPlayed', 'Total Turns Played')} colorClass="text-gray-700 dark:text-gray-200" bgClass="bg-black/5 dark:bg-white/5 border-gray-200 dark:border-slate-600" />
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${gBustRate}%`} label={t('statistics.globalBustRate', 'Global Bust Rate')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={g.highestTurnScore || 0} label={t('statistics.highestTurnGlobal', 'Highest Turn (Global)')} colorClass="text-yellow-600 dark:text-yellow-400" bgClass="bg-yellow-50 dark:bg-yellow-900/20 border-yellow-100 dark:border-yellow-500/30" />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={g.totalTurns ? Math.round((g.totalScore || 0) / g.totalTurns) : 0} label={t('statistics.avgPointsPerTurn', 'Avg Points/Turn')} />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={g.fastestWinTurns || '-'} label={t('statistics.fastestWinTurns', 'Fastest Win (Turns)')} colorClass="text-green-600 dark:text-green-400" bgClass="bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-500/30" />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={g.totalBusts || 0} label={t('statistics.totalBusts', 'Total Busts')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={g.totalGamesPlayed ? Math.round((g.totalBusts || 0) / g.totalGamesPlayed) : 0} label={t('statistics.avgBustsPerGame', 'Avg Busts / Game')} colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>
                  <h4 className="text-lg font-extrabold text-gray-800 dark:text-gray-100 border-t border-gray-200 dark:border-slate-600 pt-8 pb-6 text-center uppercase tracking-widest flex items-center justify-center gap-3">
                    <span className="text-2xl">🃏</span> {t('statistics.cardBreakdown', 'Card Breakdown')}
                  </h4>
                  <div className="max-w-2xl mx-auto flex flex-col gap-1">
                    <CardRow label={t('cards.plusMinus', 'Plus/Minus')} icon="±" count={g.totalPlusMinus || 0} wins={g.totalPlusMinusCompleted || 0} fails={Math.max(0, (g.totalPlusMinus || 0) - (g.totalPlusMinusCompleted || 0))} />
                    <CardRow label={t('cards.kniffel', 'Kniffel')} icon="🎲" count={g.totalKniffel || 0} wins={g.totalKniffelCompleted || 0} fails={Math.max(0, (g.totalKniffel || 0) - (g.totalKniffelCompleted || 0))} />
                    <CardRow label={t('cards.kleeblatt', 'Kleeblatt')} icon="🍀" count={g.totalKleeblatt || 0} wins={g.totalKleeblattCompleted || 0} fails={Math.max(0, (g.totalKleeblatt || 0) - (g.totalKleeblattCompleted || 0))} />
                    <CardRow label={t('cards.stop', 'Stop')} icon="🛑" count={g.totalStop || 0} />
                    <CardRow label={t('cards.feuerwerk', 'Feuerwerk')} icon="🎆" count={g.totalFeuerwerk || 0} wins={(g.totalFeuerwerk || 0) - (g.totalFeuerwerkBusts || 0)} fails={g.totalFeuerwerkBusts || 0} failsLabel={t('statistics.busts', 'Busts')} hideRate avgPoints={g.totalFeuerwerkPoints || 0} />
                    <CardRow label={t('cards.x2', 'x2')} icon="✖️" count={g.totalx2 || 0} wins={(g.totalx2 || 0) - (g.totalx2Busts || 0)} fails={g.totalx2Busts || 0} failsLabel={t('statistics.busts', 'Busts')} hideRate avgPoints={g.totalx2Points || 0} />
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
