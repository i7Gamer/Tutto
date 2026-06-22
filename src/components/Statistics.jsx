import React, { useState, useEffect } from 'react';
import { ArrowLeft, Trophy, Clock, XCircle, BarChart2, Globe, User, TrendingDown, TrendingUp, Zap, Hash, Repeat, FastForward, Skull } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function Statistics({ deviceId, onBack }) {
  const [tab, setTab] = useState('personal');
  const [personalStats, setPersonalStats] = useState(null);
  const [globalStats, setGlobalStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const [personalRes, globalRes] = await Promise.all([
          fetch(`/api/stats/${deviceId}`),
          fetch(`/api/stats/global`)
        ]);
        
        if (personalRes.ok) setPersonalStats(await personalRes.json());
        if (globalRes.ok) setGlobalStats(await globalRes.json());
      } catch (err) {
        console.error("Failed to load statistics:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [deviceId]);

  const formatTime = (totalSeconds) => {
    if (!totalSeconds || isNaN(totalSeconds)) return "00:00";
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  };

  const getWinLoseRate = (wins, fails) => {
    const total = wins + fails;
    if (total === 0) return "—";
    return `${((wins / total) * 100).toFixed(0)}%`;
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-full min-h-[500px]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
          <h2 className="text-xl font-bold text-gray-700 dark:text-gray-200">Loading Statistics...</h2>
        </div>
      </div>
    );
  }

  const p = personalStats;
  const g = globalStats;

  const pWinRate = p?.gamesPlayed ? ((p.wins / p.gamesPlayed) * 100).toFixed(1) : "0";
  const pAvgDuration = p?.gamesPlayed ? p.totalPlaytime / p.gamesPlayed : 0;
  const pBustRate = p?.totalTurns ? ((p.busts / p.totalTurns) * 100).toFixed(1) : "0";

  const gAvgDuration = g?.totalGamesPlayed ? g.totalPlaytime / g.totalGamesPlayed : 0;
  const gAvgScorePerTurn = g?.totalTurns ? Math.round(g.totalScore / g.totalTurns) : 0;

  const CardRow = ({ label, icon, count, wins, fails, avgPoints, hideRate, failsLabel }) => (
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
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Total</div>
        </div>
        {wins !== undefined && (
          <>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-emerald-500 dark:text-emerald-400">{wins}</div>
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Won</div>
            </div>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-red-500 dark:text-red-400">{fails}</div>
              <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{failsLabel || "Lost"}</div>
            </div>
            {!hideRate && (
              <div className="text-center min-w-[50px]">
                <div className="font-black text-lg text-indigo-600 dark:text-indigo-400">
                  {getWinLoseRate(wins, fails)}
                </div>
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Rate</div>
              </div>
            )}
          </>
        )}
        {avgPoints !== undefined && (
          <div className="text-center min-w-[50px]">
            <div className="font-black text-lg text-amber-500 dark:text-amber-400">
              {count > 0 ? Math.round(avgPoints / count) : 0}
            </div>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Avg Pts</div>
          </div>
        )}
      </div>
    </motion.div>
  );

  const StatTile = ({ icon, value, label, colorClass = 'text-indigo-600 dark:text-indigo-400', bgClass = 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-500/30' }) => (
    <div className={`p-6 rounded-2xl border relative text-left overflow-hidden shadow-sm ${bgClass}`}>
      <div className="absolute top-4 right-4 opacity-50">
        {icon}
      </div>
      <div className={`text-3xl font-black mt-2 ${colorClass}`}>{value}</div>
      <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-1 pr-8">{label}</div>
    </div>
  );

  const BigStatTile = ({ value, label, colorClass = 'text-indigo-600 dark:text-indigo-400', bgClass = 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-500/30' }) => (
    <div className={`p-8 rounded-2xl border text-center shadow-sm ${bgClass}`}>
      <div className={`text-5xl font-black mb-2 ${colorClass}`}>{value}</div>
      <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{label}</div>
    </div>
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl flex flex-col items-center">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-2xl rounded-3xl p-8"
      >
        <div className="flex items-center mb-8 relative justify-center">
          <button 
            className="absolute left-0 p-3 bg-white dark:bg-slate-800 hover:bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-600 dark:text-gray-300 transition-colors shadow-sm" 
            onClick={onBack}
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-3xl font-extrabold text-gray-800 dark:text-gray-100 flex items-center gap-3 m-0">
            <BarChart2 size={36} className="text-indigo-600" /> Statistics
          </h1>
        </div>

        <div className="flex gap-4 mb-10 justify-center">
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold transition-all ${
              tab === 'personal' 
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' 
                : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-slate-600'
            }`} 
            onClick={() => setTab('personal')}
          >
            <User size={18} /> Personal
          </motion.button>
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl font-semibold transition-all ${
              tab === 'global' 
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' 
                : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-slate-600'
            }`} 
            onClick={() => setTab('global')}
          >
            <Globe size={18} /> Global Community
          </motion.button>
        </div>

        <AnimatePresence mode="wait">
          {tab === 'personal' && (
            <motion.div 
              key="personal"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex flex-col w-full"
            >
              <h3 className="text-xl font-bold mb-6 text-center text-gray-700 dark:text-gray-200">
                Online Lifetime Record (This Device)
              </h3>
              
              {!p || !p.gamesPlayed ? (
                <div className="text-center text-gray-500 dark:text-gray-400 py-10 bg-black/5 dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-slate-700">
                  <div className="text-4xl mb-4">🎮</div>
                  You haven't played any online games on this device yet!
                </div>
              ) : (
                <div className="w-full">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <BigStatTile value={p.gamesPlayed} label="Games Played" />
                    <BigStatTile value={p.wins} label="Games Won" colorClass="text-emerald-500 dark:text-emerald-400" bgClass="bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-500/30" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Trophy size={32} className="text-amber-500" />} value={`${pWinRate}%`} label="Win Rate" colorClass="text-amber-600 dark:text-amber-400" bgClass="bg-amber-50 dark:bg-amber-900/20 border-amber-100 dark:border-amber-500/30" />
                    <StatTile icon={<Clock size={32} className="text-indigo-400" />} value={formatTime(pAvgDuration)} label="Avg Duration" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${pBustRate}%`} label="Bust Rate" colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                    <StatTile icon={<XCircle size={32} className="text-red-400" />} value={p.pointsDeducted || 0} label="-1000 Pts Eaten" colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Repeat size={32} className="text-gray-400" />} value={p.totalTurns || 0} label="Total Turns" colorClass="text-gray-700 dark:text-gray-200" bgClass="bg-black/5 dark:bg-white/5 border-gray-200 dark:border-slate-600" />
                    <StatTile icon={<Clock size={32} className="text-gray-400" />} value={formatTime(p.totalPlaytime)} label="Total Playtime" colorClass="text-gray-700 dark:text-gray-200" bgClass="bg-black/5 dark:bg-white/5 border-gray-200 dark:border-slate-600" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Hash size={32} className="text-orange-400" />} value={p.busts || 0} label="Total Busts" colorClass="text-orange-600 dark:text-orange-400" bgClass="bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-500/30" />
                    <StatTile icon={<Hash size={32} className="text-orange-400" />} value={p.gamesPlayed ? ((p.busts || 0) / p.gamesPlayed).toFixed(1) : 0} label="Avg Busts / Game" colorClass="text-orange-600 dark:text-orange-400" bgClass="bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-500/30" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={p.highestTurnScore || 0} label="Highest Turn" colorClass="text-yellow-600 dark:text-yellow-400" bgClass="bg-yellow-50 dark:bg-yellow-900/20 border-yellow-100 dark:border-yellow-500/30" />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={p.totalTurns ? Math.round((p.totalScore || 0) / p.totalTurns) : 0} label="Avg Points/Turn" colorClass="text-indigo-600 dark:text-indigo-400" bgClass="bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-500/30" />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={p.fastestWinTurns || '-'} label="Fastest Win (Turns)" colorClass="text-green-600 dark:text-green-400" bgClass="bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-500/30" />
                    <StatTile icon={<Skull size={32} className="text-red-400" />} value={p.fastestLossTurns || '-'} label="Fastest Loss (Turns)" colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>

                  <h4 className="text-lg font-extrabold text-gray-800 dark:text-gray-100 border-t border-gray-200 dark:border-slate-600 pt-8 pb-6 text-center uppercase tracking-widest flex items-center justify-center gap-3">
                    <span className="text-2xl">🃏</span> Card Breakdown
                  </h4>
                  <div className="max-w-2xl mx-auto flex flex-col gap-1">
                    <CardRow
                      label="Plus/Minus" icon="±"
                      count={(p.plusMinusCompleted || 0) + (p.plusMinusFailed || 0)}
                      wins={p.plusMinusCompleted || 0} fails={p.plusMinusFailed || 0}
                    />
                    <CardRow
                      label="Kniffel" icon="🎲"
                      count={(p.kniffelCompleted || 0) + (p.kniffelFailed || 0)}
                      wins={p.kniffelCompleted || 0} fails={p.kniffelFailed || 0}
                    />
                    <CardRow
                      label="Kleeblatt" icon="🍀"
                      count={(p.kleeblattCompleted || 0) + (p.kleeblattFailed || 0)}
                      wins={p.kleeblattCompleted || 0} fails={p.kleeblattFailed || 0}
                    />
                    <CardRow label="Stop" icon="🛑" count={p.skipped || 0} />
                    <CardRow 
                      label="Feuerwerk" icon="🎆" 
                      count={p.feuerwerkReceived || 0} 
                      wins={(p.feuerwerkReceived || 0) - (p.feuerwerkBusts || 0)} 
                      fails={p.feuerwerkBusts || 0} 
                      failsLabel="Busts"
                      hideRate={true}
                      avgPoints={p.feuerwerkPointsScored || 0} 
                    />
                    <CardRow 
                      label="x2" icon="✖️" 
                      count={p.x2Received || 0} 
                      wins={(p.x2Received || 0) - (p.x2Busts || 0)} 
                      fails={p.x2Busts || 0} 
                      failsLabel="Busts"
                      hideRate={true}
                      avgPoints={p.x2PointsScored || 0} 
                    />
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {tab === 'global' && (
            <motion.div 
              key="global"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="flex flex-col w-full"
            >
              <div className="text-center mb-8">
                <h3 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-2">
                  Global Community Statistics
                </h3>
                <p className="text-gray-500 dark:text-gray-400 font-medium">Aggregated across all local and online games played.</p>
              </div>
              
              {!g || !g.totalGamesPlayed ? (
                <div className="text-center text-gray-500 dark:text-gray-400 py-10 bg-black/5 dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-slate-700">
                  <div className="text-4xl mb-4">🌍</div>
                  No games have been played on the server yet!
                </div>
              ) : (
                <div className="w-full">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <BigStatTile value={g.totalGamesPlayed} label="Total Games" />
                    <BigStatTile value={formatTime(g.totalPlaytime)} label="Total Playtime" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Clock size={32} className="text-emerald-400" />} value={formatTime(gAvgDuration)} label="Avg Game Duration" colorClass="text-emerald-600 dark:text-emerald-400" bgClass="bg-emerald-50 dark:bg-emerald-900/20 border-emerald-100 dark:border-emerald-500/30" />
                    <StatTile icon={<Zap size={32} className="text-indigo-400" />} value={g.totalScore || 0} label="Total Points Scored" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                    <StatTile icon={<Repeat size={32} className="text-gray-400" />} value={g.totalTurns || 0} label="Total Turns Played" colorClass="text-gray-700 dark:text-gray-200" bgClass="bg-black/5 dark:bg-white/5 border-gray-200 dark:border-slate-600" />
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${gBustRate}%`} label="Global Bust Rate" colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={g.highestTurnScore || 0} label="Highest Turn (Global)" colorClass="text-yellow-600 dark:text-yellow-400" bgClass="bg-yellow-50 dark:bg-yellow-900/20 border-yellow-100 dark:border-yellow-500/30" />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={g.totalTurns ? Math.round((g.totalScore || 0) / g.totalTurns) : 0} label="Avg Points/Turn" colorClass="text-indigo-600 dark:text-indigo-400" bgClass="bg-indigo-50 dark:bg-indigo-900/20 border-indigo-100 dark:border-indigo-500/30" />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={g.fastestWinTurns || '-'} label="Fastest Win (Turns)" colorClass="text-green-600 dark:text-green-400" bgClass="bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-500/30" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={g.totalBusts || 0} label="Total Busts" colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={g.totalGamesPlayed ? ((g.totalBusts || 0) / g.totalGamesPlayed).toFixed(1) : 0} label="Avg Busts / Game" colorClass="text-red-600 dark:text-red-400" bgClass="bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-500/30" />
                  </div>

                  <h4 className="text-lg font-extrabold text-gray-800 dark:text-gray-100 border-t border-gray-200 dark:border-slate-600 pt-8 pb-6 text-center uppercase tracking-widest flex items-center justify-center gap-3">
                    <span className="text-2xl">🃏</span> Card Breakdown
                  </h4>
                  <div className="max-w-2xl mx-auto flex flex-col gap-1">
                    <CardRow 
                      label="Plus/Minus" icon="±" 
                      count={g.totalPlusMinus || 0} 
                      wins={g.totalPlusMinusCompleted || 0}
                      fails={(g.totalPlusMinus || 0) - (g.totalPlusMinusCompleted || 0)}
                    />
                    <CardRow 
                      label="Kniffel" icon="🎲" 
                      count={g.totalKniffel || 0} 
                      wins={g.totalKniffelCompleted || 0}
                      fails={(g.totalKniffel || 0) - (g.totalKniffelCompleted || 0)}
                    />
                    <CardRow
                      label="Kleeblatt" icon="🍀"
                      count={g.totalKleeblatt || 0}
                      wins={g.totalKleeblattCompleted || 0}
                      fails={(g.totalKleeblatt || 0) - (g.totalKleeblattCompleted || 0)}
                    />
                    <CardRow label="Stop" icon="🛑" count={g.totalStop || 0} />
                    <CardRow 
                      label="Feuerwerk" icon="🎆" 
                      count={g.totalFeuerwerk || 0} 
                      wins={(g.totalFeuerwerk || 0) - (g.totalFeuerwerkBusts || 0)} 
                      fails={g.totalFeuerwerkBusts || 0} 
                      failsLabel="Busts"
                      hideRate={true}
                      avgPoints={g.totalFeuerwerkPoints || 0} 
                    />
                    <CardRow 
                      label="x2" icon="✖️" 
                      count={g.totalx2 || 0} 
                      wins={(g.totalx2 || 0) - (g.totalx2Busts || 0)} 
                      fails={g.totalx2Busts || 0} 
                      failsLabel="Busts"
                      hideRate={true}
                      avgPoints={g.totalx2Points || 0} 
                    />
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
