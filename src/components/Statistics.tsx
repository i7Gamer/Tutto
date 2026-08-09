import { useState, useEffect } from 'react';
import { Trophy, Clock, Hash, FastForward, BarChart2, Globe, User, TrendingDown, TrendingUp, Zap, Repeat, Skull, XCircle, ArrowLeft } from 'lucide-react';
import { formatTime } from '../utils/formatTime';
import { parseJsonObject } from '../utils/parseJson';
import { CARD_EMOJIS } from '../utils/cardVisuals';
import { STAT_TONES, DEFAULT_STAT_TONE, type StatTone } from '../utils/statTones';
import { percentageOf } from '../utils/percentage';
import { deviceStatsUrl } from '../utils/statsApi';
import { DEFAULT_GAME_MODE, type CardType, type GameMode } from '../types';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import React from 'react';
import './Statistics.css';

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
  mostPlayersInGame?: number;
  totalPlayersSum?: number;
  longestGameRounds?: number;
  totalRoundsSum?: number;
  highestFeuerwerkTurnScore?: number;
  highestX2TurnScore?: number;
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
  mostPlayersInGame?: number;
  totalPlayersSum?: number;
  longestGameRounds?: number;
  totalRoundsSum?: number;
  highestFeuerwerkTurnScore?: number;
  highestX2TurnScore?: number;
  defaultGamesPlayed?: number;
  customGamesPlayed?: number;
}

// The run of wins at which the streak tile starts celebrating — flame, pulse
// and the brighter amber all switch on together.
const HOT_WIN_STREAK = 3;

// Heads the card breakdown: a playing card in general, not any one card.
const CARD_BREAKDOWN_ICON = '🃏';

// A dash, not 0%: a card that has never been drawn has no rate, and showing
// zero would read as "never once managed it".
const NO_RATE = '—';

const getWinLoseRate = (wins: number, fails: number): string => {
  const rate = percentageOf(wins, wins + fails);
  return rate === null ? NO_RATE : `${rate}%`;
};

// This device (tied-for-)holds the record when its value matches the global
// max/min exactly — only meaningful once both sides have real data.
const isRecordHolder = (personal?: number | null, global?: number | null): boolean =>
  !!(personal && global && personal > 0 && global > 0 && personal === global);

// The two personal buckets, in the order they are offered.
const MODE_TABS: readonly { value: GameMode; labelKey: string; labelFallback: string }[] = [
  { value: 'normalized', labelKey: 'statistics.normalGames', labelFallback: 'Normal' },
  { value: 'custom', labelKey: 'statistics.customGames', labelFallback: 'Custom' },
];

interface GlobalComparison {
  pct: number;
  isBetter: boolean;
}

// `global <= 0` covers both "no global games recorded yet" and the (rare)
// legitimate zero baseline — either way there's nothing meaningful to divide by.
const compareToGlobal = (personal: number | null, global: number | null, lowerIsBetter: boolean): GlobalComparison | null => {
  if (personal == null || global == null || global <= 0) return null;
  const diffPct = ((personal - global) / global) * 100;
  if (diffPct === 0) return null;
  const isBetter = lowerIsBetter ? diffPct < 0 : diffPct > 0;
  return { pct: Math.abs(Math.round(diffPct)), isBetter };
};

interface StatTileProps {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
  tone?: StatTone;
  badge?: React.ReactNode;
}

const StatTile = ({ icon, value, label, tone = DEFAULT_STAT_TONE, badge }: StatTileProps) => (
  <div className={`p-6 rounded-2xl border relative text-left overflow-hidden shadow-sm ${STAT_TONES[tone].surface}`}>
    <div className="absolute top-4 right-4 opacity-50">{icon}</div>
    <div className={`text-3xl font-black mt-2 ${STAT_TONES[tone].text}`}>{value}</div>
    <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-1 pr-8">{label}</div>
    {badge && <div className="text-xs font-bold mt-2">{badge}</div>}
  </div>
);

const RecordBadge = () => {
  const { t } = useTranslation();
  return <span className="text-amber-500 dark:text-amber-400">🏆 {t('statistics.globalRecord', 'Global Record!')}</span>;
};

const ComparisonBadge = ({ comparison }: { comparison: GlobalComparison | null }) => {
  const { t } = useTranslation();
  if (!comparison) return null;
  return (
    <span className={comparison.isBetter ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}>
      {comparison.pct}% {comparison.isBetter
        ? t('statistics.betterThanGlobalAvg', 'better than global avg')
        : t('statistics.worseThanGlobalAvg', 'worse than global avg')}
    </span>
  );
};

interface BigStatTileProps {
  value: React.ReactNode;
  label: string;
  tone?: StatTone;
}

const BigStatTile = ({ value, label, tone = DEFAULT_STAT_TONE }: BigStatTileProps) => (
  <div className={`p-8 rounded-2xl border text-center shadow-sm ${STAT_TONES[tone].surface}`}>
    <div className={`text-5xl font-black mb-2 ${STAT_TONES[tone].text}`}>{value}</div>
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

// One row of the card breakdown, before it knows whose numbers it is showing.
// The personal and global tabs each build this list from their own stats; the
// rows themselves — which cards, in which order, and which of them count
// their failures as busts — are the same on both, and used to be written out
// twice.
interface CardBreakdownRow {
  card: CardType;
  labelKey: string;
  labelFallback: string;
  count: number;
  wins?: number;
  fails?: number;
  avgPoints?: number;
}

// Feuerwerk and x2 are never "lost": you either bank points or bust, so a
// win/lose rate would be meaningless for them.
const SCORING_CARDS: readonly CardType[] = ['Feuerwerk', 'x2'];

const personalCardBreakdown = (p: PersonalStats): CardBreakdownRow[] => [
  { card: 'Plus_Minus', labelKey: 'cards.plusMinus', labelFallback: 'Plus/Minus', count: (p.plusMinusCompleted || 0) + (p.plusMinusFailed || 0), wins: p.plusMinusCompleted || 0, fails: p.plusMinusFailed || 0 },
  { card: 'Kniffel', labelKey: 'cards.kniffel', labelFallback: 'Kniffel', count: (p.kniffelCompleted || 0) + (p.kniffelFailed || 0), wins: p.kniffelCompleted || 0, fails: p.kniffelFailed || 0 },
  { card: 'Kleeblatt', labelKey: 'cards.kleeblatt', labelFallback: 'Kleeblatt', count: (p.kleeblattCompleted || 0) + (p.kleeblattFailed || 0), wins: p.kleeblattCompleted || 0, fails: p.kleeblattFailed || 0 },
  { card: 'Stop', labelKey: 'cards.stop', labelFallback: 'Stop', count: p.skipped || 0 },
  { card: 'Feuerwerk', labelKey: 'cards.feuerwerk', labelFallback: 'Feuerwerk', count: p.feuerwerkReceived || 0, wins: (p.feuerwerkReceived || 0) - (p.feuerwerkBusts || 0), fails: p.feuerwerkBusts || 0, avgPoints: p.feuerwerkPointsScored || 0 },
  { card: 'x2', labelKey: 'cards.x2', labelFallback: 'x2', count: p.x2Received || 0, wins: (p.x2Received || 0) - (p.x2Busts || 0), fails: p.x2Busts || 0, avgPoints: p.x2PointsScored || 0 },
];

const globalCardBreakdown = (g: GlobalStats): CardBreakdownRow[] => [
  // The server stores completions and totals rather than failures, so the
  // losses are the remainder — floored at zero, because the two counters are
  // written by different code paths and a mid-game crash can leave them
  // disagreeing.
  { card: 'Plus_Minus', labelKey: 'cards.plusMinus', labelFallback: 'Plus/Minus', count: g.totalPlusMinus || 0, wins: g.totalPlusMinusCompleted || 0, fails: Math.max(0, (g.totalPlusMinus || 0) - (g.totalPlusMinusCompleted || 0)) },
  { card: 'Kniffel', labelKey: 'cards.kniffel', labelFallback: 'Kniffel', count: g.totalKniffel || 0, wins: g.totalKniffelCompleted || 0, fails: Math.max(0, (g.totalKniffel || 0) - (g.totalKniffelCompleted || 0)) },
  { card: 'Kleeblatt', labelKey: 'cards.kleeblatt', labelFallback: 'Kleeblatt', count: g.totalKleeblatt || 0, wins: g.totalKleeblattCompleted || 0, fails: Math.max(0, (g.totalKleeblatt || 0) - (g.totalKleeblattCompleted || 0)) },
  { card: 'Stop', labelKey: 'cards.stop', labelFallback: 'Stop', count: g.totalStop || 0 },
  { card: 'Feuerwerk', labelKey: 'cards.feuerwerk', labelFallback: 'Feuerwerk', count: g.totalFeuerwerk || 0, wins: (g.totalFeuerwerk || 0) - (g.totalFeuerwerkBusts || 0), fails: g.totalFeuerwerkBusts || 0, avgPoints: g.totalFeuerwerkPoints || 0 },
  { card: 'x2', labelKey: 'cards.x2', labelFallback: 'x2', count: g.totalx2 || 0, wins: (g.totalx2 || 0) - (g.totalx2Busts || 0), fails: g.totalx2Busts || 0, avgPoints: g.totalx2Points || 0 },
];

const CardBreakdown = ({ rows }: { rows: CardBreakdownRow[] }) => {
  const { t } = useTranslation();
  return (
    <>
      <h4 className="text-lg font-extrabold text-gray-800 dark:text-gray-100 border-t border-gray-200 dark:border-slate-600 pt-8 pb-6 text-center uppercase tracking-widest flex items-center justify-center gap-3">
        <span className="text-2xl">{CARD_BREAKDOWN_ICON}</span> {t('statistics.cardBreakdown', 'Card Breakdown')}
      </h4>
      <div className="max-w-2xl mx-auto flex flex-col gap-1">
        {rows.map(row => {
          const scoringCard = SCORING_CARDS.includes(row.card);
          return (
            <CardRow
              key={row.card}
              label={t(row.labelKey, row.labelFallback)}
              icon={CARD_EMOJIS[row.card]}
              count={row.count}
              wins={row.wins}
              fails={row.fails}
              avgPoints={row.avgPoints}
              hideRate={scoringCard}
              failsLabel={scoringCard ? t('statistics.busts', 'Busts') : undefined}
            />
          );
        })}
      </div>
    </>
  );
};

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
          <div className="stat-caption">{t('statistics.total', 'Total')}</div>
        </div>
        {wins !== undefined && (
          <>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-emerald-500 dark:text-emerald-400">{wins}</div>
              <div className="stat-caption">{t('statistics.won', 'Won')}</div>
            </div>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-red-500 dark:text-red-400">{fails}</div>
              <div className="stat-caption">{failsLabel || t('statistics.lost', 'Lost')}</div>
            </div>
            {!hideRate && (
              <div className="text-center min-w-[50px]">
                <div className="font-black text-lg text-indigo-600 dark:text-indigo-400">{getWinLoseRate(wins, fails ?? 0)}</div>
                <div className="stat-caption">{t('statistics.rate', 'Rate')}</div>
              </div>
            )}
          </>
        )}
        {avgPoints !== undefined && (
          <div className="text-center min-w-[50px]">
            <div className="font-black text-lg text-amber-500 dark:text-amber-400">{count > 0 ? Math.round(avgPoints / count) : 0}</div>
            <div className="stat-caption">{t('statistics.avgPts', 'Avg Pts')}</div>
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
  // Which personal bucket is on screen. Games with a changed winning score or
  // deck are recorded separately and never counted anywhere else, so they need
  // somewhere of their own to be seen.
  const [mode, setMode] = useState<GameMode>(DEFAULT_GAME_MODE);
  const [personalStats, setPersonalStats] = useState<PersonalStats | null>(null);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const fetchStats = async () => {
      try {
        // Deliberately no setLoading(true) here. The first render already
        // starts in the loading state, and re-entering it when the mode
        // switches would replace the whole page — the tabs that were just
        // clicked included — with the spinner. The previous bucket's numbers
        // stay put for the moment the new ones take to arrive.
        const [personalRes, globalRes] = await Promise.all([
          fetch(deviceStatsUrl(deviceId, mode)),
          fetch('/api/stats/global'),
        ]);
        if (!isMounted) return;
        if (personalRes.ok) setPersonalStats(await parseJsonObject<PersonalStats>(personalRes));
        if (!isMounted) return;
        if (globalRes.ok) setGlobalStats(await parseJsonObject<GlobalStats>(globalRes));
      } catch (err) {
        console.error('Failed to load statistics:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    void fetchStats();

    return () => {
      isMounted = false;
    };
  }, [deviceId, mode]);

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

  // These tiles read 0% with nothing played yet, rather than the dash the card
  // breakdown uses: they sit beside a "Games Played: 0" that already says so.
  const pWinRate = percentageOf(p?.wins ?? 0, p?.gamesPlayed ?? 0) ?? 0;
  const pAvgDuration = p?.gamesPlayed ? p.totalPlaytime / p.gamesPlayed : 0;
  const pBustRate = percentageOf(p?.busts ?? 0, p?.totalTurns ?? 0) ?? 0;
  const gAvgDuration = g?.totalGamesPlayed ? g.totalPlaytime / g.totalGamesPlayed : 0;
  const gBustRate = percentageOf(g?.totalBusts ?? 0, g?.totalTurns ?? 0) ?? 0;

  const pBustRateNum = p?.totalTurns ? ((p.busts ?? 0) / p.totalTurns) * 100 : null;
  const gBustRateNum = g?.totalTurns ? ((g.totalBusts ?? 0) / g.totalTurns) * 100 : null;
  const pAvgPtsPerTurnNum = p?.totalTurns ? (p.totalScore ?? 0) / p.totalTurns : null;
  const gAvgPtsPerTurnNum = g?.totalTurns ? (g.totalScore ?? 0) / g.totalTurns : null;

  // Every comparison on this screen measures against the global row, and that
  // row holds normalized games only. In the custom view there is no comparable
  // population: no average to beat, and no record that could be held.
  const isCustomView = mode === 'custom';
  const bustRateComparison = isCustomView ? null : compareToGlobal(pBustRateNum, gBustRateNum, true);
  const avgPtsPerTurnComparison = isCustomView ? null : compareToGlobal(pAvgPtsPerTurnNum, gAvgPtsPerTurnNum, false);
  const holdsRecord = (personal?: number | null, global?: number | null): boolean =>
    !isCustomView && isRecordHolder(personal, global);

  const isOnAHotStreak = (p?.currentWinStreak || 0) >= HOT_WIN_STREAK;

  const pAvgPlayersPerGame = p?.gamesPlayed ? Math.round((p.totalPlayersSum ?? 0) / p.gamesPlayed) : 0;
  const pAvgRoundsPerGame = p?.gamesPlayed ? Math.round((p.totalRoundsSum ?? 0) / p.gamesPlayed) : 0;
  const gAvgPlayersPerGame = g?.totalGamesPlayed ? Math.round((g.totalPlayersSum ?? 0) / g.totalGamesPlayed) : 0;
  const gAvgRoundsPerGame = g?.totalGamesPlayed ? Math.round((g.totalRoundsSum ?? 0) / g.totalGamesPlayed) : 0;

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

              <div className="flex gap-2 mb-6 justify-center" role="tablist">
                {MODE_TABS.map(({ value, labelKey, labelFallback }) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={mode === value}
                    className={`px-5 py-2 rounded-lg text-sm font-bold transition-all ${mode === value ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-700' : 'bg-white dark:bg-slate-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-slate-600 hover:bg-black/5'}`}
                    onClick={() => setMode(value)}
                  >
                    {t(labelKey, labelFallback)}
                  </button>
                ))}
              </div>
              {isCustomView && (
                <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-6 max-w-xl mx-auto">
                  {t('statistics.customGamesExplainer', 'Games with a changed winning score or deck. They are kept separately and never count toward your normal record or the global statistics.')}
                </p>
              )}

              {!p || !p.gamesPlayed ? (
                <div className="text-center text-gray-500 dark:text-gray-400 py-10 bg-black/5 dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-slate-700">
                  <div className="text-4xl mb-4">🎮</div>
                  {isCustomView
                    ? t('statistics.noCustomGames', "You haven't played any custom online games on this device yet!")
                    : t('statistics.noPersonalGames', "You haven't played any online games on this device yet!")}
                </div>
              ) : (
                <div className="w-full">
                  <div className="stat-grid-2 mb-4">
                    <BigStatTile value={p.gamesPlayed} label={t('statistics.gamesPlayed', 'Games Played')} />
                    <BigStatTile value={p.wins} label={t('statistics.gamesWon', 'Games Won')} tone="emerald" />
                  </div>
                  <div className="stat-grid-3 mb-4">
                    <StatTile icon={<Trophy size={32} className="text-amber-500" />} value={`${pWinRate}%`} label={t('statistics.winRate', 'Win Rate')} tone="amber" />
                    <StatTile icon={<Clock size={32} className="text-indigo-400" />} value={formatTime(pAvgDuration)} label={t('statistics.avgDuration', 'Avg Duration')} />
                    <StatTile icon={<Repeat size={32} className="text-gray-400" />} value={p.totalTurns || 0} label={t('statistics.totalTurns', 'Total Turns')} tone="neutral" />
                  </div>
                  <div className="stat-grid-2 mb-4">
                    <StatTile
                      icon={<Zap size={32} className={`text-amber-500 ${isOnAHotStreak ? 'animate-pulse' : ''}`} />}
                      value={isOnAHotStreak ? `🔥 ${p.currentWinStreak}` : (p.currentWinStreak || 0)}
                      label={t('statistics.currentWinStreak', 'Current Win Streak')}
                      tone={isOnAHotStreak ? 'amberHot' : 'amber'}
                    />
                    <StatTile 
                      icon={<Trophy size={32} className="text-amber-500" />} 
                      value={p.bestWinStreak || 0} 
                      label={t('statistics.bestWinStreak', 'Best Win Streak')} 
                      tone="amber" 
                    />
                  </div>
                  <div className="stat-grid-2 mb-4">
                    <StatTile icon={<XCircle size={32} className="text-red-400" />} value={p.pointsDeducted || 0} label={t('statistics.ptsEaten', '-1000 Pts Eaten')} tone="red" />
                    <StatTile icon={<Clock size={32} className="text-gray-400" />} value={formatTime(p.totalPlaytime)} label={t('statistics.totalPlaytime', 'Total Playtime')} tone="neutral" />
                  </div>
                  <div className="stat-grid-3 mb-4">
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={p.busts || 0} label={t('statistics.totalBusts', 'Total Busts')} tone="red" />
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={p.gamesPlayed ? Math.round((p.busts || 0) / p.gamesPlayed) : 0} label={t('statistics.avgBustsPerGame', 'Avg Busts / Game')} tone="red" />
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${pBustRate}%`} label={t('statistics.bustRate', 'Bust Rate')} tone="red" badge={<ComparisonBadge comparison={bustRateComparison} />} />
                  </div>
                  <div className="stat-grid-4 mb-4">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={p.highestTurnScore || 0} label={t('statistics.highestTurn', 'Highest Turn')} tone="yellow" badge={holdsRecord(p.highestTurnScore, g?.highestTurnScore) && <RecordBadge />} />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={p.totalTurns ? Math.round((p.totalScore || 0) / p.totalTurns) : 0} label={t('statistics.avgPointsPerTurn', 'Avg Points/Turn')} badge={<ComparisonBadge comparison={avgPtsPerTurnComparison} />} />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={p.fastestWinTurns || '-'} label={t('statistics.fastestWinTurns', 'Fastest Win (Turns)')} tone="green" badge={holdsRecord(p.fastestWinTurns, g?.fastestWinTurns) && <RecordBadge />} />
                    <StatTile icon={<Skull size={32} className="text-red-400" />} value={p.fastestLossTurns || '-'} label={t('statistics.fastestLossTurns', 'Fastest Loss (Turns)')} tone="red" />
                  </div>
                  <div className="stat-grid-4 mb-4">
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={p.mostPlayersInGame || 0} label={t('statistics.mostPlayersInGame', 'Most Players in a Game')} tone="sky" />
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={pAvgPlayersPerGame} label={t('statistics.avgPlayersPerGame', 'Avg Players/Game')} tone="sky" />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={p.longestGameRounds || 0} label={t('statistics.longestGameRounds', 'Longest Game (Rounds)')} tone="purple" badge={holdsRecord(p.longestGameRounds, g?.longestGameRounds) && <RecordBadge />} />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={pAvgRoundsPerGame} label={t('statistics.avgRoundsPerGame', 'Avg Rounds/Game')} tone="purple" />
                  </div>
                  <div className="stat-grid-2 mb-8">
                    <StatTile icon={<Zap size={32} className="text-orange-400" />} value={p.highestFeuerwerkTurnScore || 0} label={t('statistics.highestFeuerwerkTurn', 'Highest Feuerwerk Turn')} tone="orange" badge={holdsRecord(p.highestFeuerwerkTurnScore, g?.highestFeuerwerkTurnScore) && <RecordBadge />} />
                    <StatTile icon={<Zap size={32} className="text-pink-400" />} value={p.highestX2TurnScore || 0} label={t('statistics.highestX2Turn', 'Highest x2 Turn')} tone="pink" badge={holdsRecord(p.highestX2TurnScore, g?.highestX2TurnScore) && <RecordBadge />} />
                  </div>
                  <CardBreakdown rows={personalCardBreakdown(p)} />
                </div>
              )}
            </motion.div>
          )}

          {tab === 'global' && (
            <motion.div key="global" role="tabpanel" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex flex-col w-full">
              <div className="text-center mb-8">
                <h3 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-2">{t('statistics.globalCommunityTitle', 'Global Community Statistics')}</h3>
                <p className="text-gray-500 dark:text-gray-400 font-medium">{t('statistics.globalDescription', 'Aggregated across all normal online games played.')}</p>
                {/* Custom games are recorded as nothing but this count — see
                    updateGlobalStats. Saying so is what keeps the totals above
                    from reading as "every game ever played". */}
                {!!g?.customGamesPlayed && (
                  <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
                    {t('statistics.customGamesNotCounted', 'Custom games played: {{count}} (not counted here)', { count: g.customGamesPlayed })}
                  </p>
                )}
              </div>
              {!g || !g.totalGamesPlayed ? (
                <div className="text-center text-gray-500 dark:text-gray-400 py-10 bg-black/5 dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-slate-700">
                  <div className="text-4xl mb-4">🌍</div>
                  {t('statistics.noGlobalGames', 'No games have been played on the server yet!')}
                </div>
              ) : (
                <div className="w-full">
                  <div className="stat-grid-2 mb-4">
                    <BigStatTile value={g.totalGamesPlayed} label={t('statistics.totalGames', 'Total Games')} />
                    <BigStatTile value={formatTime(g.totalPlaytime)} label={t('statistics.totalPlaytime', 'Total Playtime')} />
                  </div>
                  <div className="stat-grid-3 mb-4">
                    <StatTile icon={<Clock size={32} className="text-emerald-400" />} value={formatTime(gAvgDuration)} label={t('statistics.avgGameDuration', 'Avg Game Duration')} tone="emerald" />
                    <StatTile icon={<Zap size={32} className="text-indigo-400" />} value={g.totalScore || 0} label={t('statistics.totalPointsScored', 'Total Points Scored')} />
                    <StatTile icon={<Repeat size={32} className="text-gray-400" />} value={g.totalTurns || 0} label={t('statistics.totalTurnsPlayed', 'Total Turns Played')} tone="neutral" />
                  </div>
                  <div className="stat-grid-3 mb-4">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={g.highestTurnScore || 0} label={t('statistics.highestTurnGlobal', 'Highest Turn (Global)')} tone="yellow" />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={g.totalTurns ? Math.round((g.totalScore || 0) / g.totalTurns) : 0} label={t('statistics.avgPointsPerTurn', 'Avg Points/Turn')} />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={g.fastestWinTurns || '-'} label={t('statistics.fastestWinTurns', 'Fastest Win (Turns)')} tone="green" />
                  </div>
                  <div className="stat-grid-4 mb-4">
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={g.mostPlayersInGame || 0} label={t('statistics.mostPlayersInGame', 'Most Players in a Game')} tone="sky" />
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={gAvgPlayersPerGame} label={t('statistics.avgPlayersPerGame', 'Avg Players/Game')} tone="sky" />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={g.longestGameRounds || 0} label={t('statistics.longestGameRounds', 'Longest Game (Rounds)')} tone="purple" />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={gAvgRoundsPerGame} label={t('statistics.avgRoundsPerGame', 'Avg Rounds/Game')} tone="purple" />
                  </div>
                  <div className="stat-grid-2 mb-4">
                    <StatTile icon={<Zap size={32} className="text-orange-400" />} value={g.highestFeuerwerkTurnScore || 0} label={t('statistics.highestFeuerwerkTurn', 'Highest Feuerwerk Turn')} tone="orange" />
                    <StatTile icon={<Zap size={32} className="text-pink-400" />} value={g.highestX2TurnScore || 0} label={t('statistics.highestX2Turn', 'Highest x2 Turn')} tone="pink" />
                  </div>
                  <div className="stat-grid-3 mb-8">
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={g.totalBusts || 0} label={t('statistics.totalBusts', 'Total Busts')} tone="red" />
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={g.totalGamesPlayed ? Math.round((g.totalBusts || 0) / g.totalGamesPlayed) : 0} label={t('statistics.avgBustsPerGame', 'Avg Busts / Game')} tone="red" />
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${gBustRate}%`} label={t('statistics.globalBustRate', 'Global Bust Rate')} tone="red" />
                  </div>
                  <CardBreakdown rows={globalCardBreakdown(g)} />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
