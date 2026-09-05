import { useId, useState, useEffect } from 'react';
import { Trophy, Clock, Hash, FastForward, BarChart2, Globe, User, TrendingDown, TrendingUp, Zap, Repeat, Skull, XCircle, ArrowLeft, Layers } from 'lucide-react';
import { formatTime } from '../utils/formatTime';
import { formatInt, formatFixed, AVG_DECIMALS } from '../utils/formatNumber';
import { parseJsonObject } from '../utils/parseJson';
import { CARD_EMOJIS } from '../utils/cardVisuals';
import { STAT_TONES, DEFAULT_STAT_TONE, type StatTone } from '../utils/statTones';
import { percentageOf } from '../utils/percentage';
import { isRecordHolder, type RecordField } from '../utils/statRecords';
import { useDeviceStats, type DeviceStatsStatus } from '../hooks/useDeviceStats';
import { useRovingTabs } from '../hooks/useRovingTabs';
import { HOT_WIN_STREAK } from '../utils/playerStats';
import {
  DEFAULT_GAME_MODE, type CardType, type GameMode, type Ruleset,
  type DeviceStatsRow, type GlobalStatsRow,
} from '../types';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import React from 'react';
import './Statistics.css';
import PageContainer from './PageContainer';

// This device's own stats, as fetched for display — every DeviceStatsRow
// column except the primary key (deviceId, mode), which this screen never
// shows. Only the three fields the screen cannot render sensibly as "no data
// yet" are required; the rest come back Partial so a personal-bests scope
// that has never recorded a field (or an older payload predating it) can omit
// it, same as the wire payload always could.
type PersonalStats =
  & Pick<DeviceStatsRow, 'gamesPlayed' | 'wins' | 'totalPlaytime'>
  & Partial<Omit<DeviceStatsRow, 'deviceId' | 'mode' | 'gamesPlayed' | 'wins' | 'totalPlaytime'>>;

// The matching global row, as fetched for display — every GlobalStatsRow
// column except the ruleset primary key, which is selected via RULESET_TABS
// rather than shown per-field.
type GlobalStats =
  & Pick<GlobalStatsRow, 'totalGamesPlayed' | 'totalPlaytime'>
  & Partial<Omit<GlobalStatsRow, 'ruleset' | 'totalGamesPlayed' | 'totalPlaytime'>>;

// Heads the card breakdown: a playing card in general, not any one card.
const CARD_BREAKDOWN_ICON = '🃏';

// A dash, not 0%: a card that has never been drawn has no rate, and showing
// zero would read as "never once managed it".
const NO_RATE = '—';

const getWinLoseRate = (wins: number, fails: number): string => {
  const rate = percentageOf(wins, wins + fails);
  return rate === null ? NO_RATE : `${rate}%`;
};

// The two personal buckets, in the order they are offered. Within a ruleset:
// the classic pair maps onto 'classic'/'classic_custom' (see bucketMode).
const MODE_TABS: readonly { value: GameMode; labelKey: string; labelFallback: string }[] = [
  { value: 'normalized', labelKey: 'statistics.normalGames', labelFallback: 'Normal' },
  { value: 'custom', labelKey: 'statistics.customGames', labelFallback: 'Custom' },
];

// The two rulesets, each with its own bucket pair and its own global row.
const RULESET_TABS: readonly { value: Ruleset; labelKey: string; labelFallback: string }[] = [
  { value: 'modernized', labelKey: 'lobby.rulesetModernized', labelFallback: 'Modernized' },
  { value: 'classic', labelKey: 'lobby.rulesetClassic', labelFallback: 'Classic' },
];

// The ruleset and normal/custom rows share the personal/global row's look —
// one selected/unselected treatment for every tab on this screen, a step down
// in size from the top-level pair so the hierarchy still reads.
// shrink-0: without it a flex-nowrap row squeezes its pills to fit instead
// of overflowing into the scrollbar C69.2 adds below. The smaller size below
// `sm:` keeps a three-tab row (the widest case) to one line at 375px; `sm:`
// and up restore the original size unchanged.
const subTabClass = (selected: boolean): string =>
  `shrink-0 px-3 py-2 text-sm sm:px-5 sm:py-2.5 sm:text-base rounded-xl font-semibold transition-all ${selected
    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30'
    : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-black/5 border border-gray-200 dark:border-slate-600'}`;

// (rulesetTab, normal/custom tab) → the stored device bucket.
const bucketMode = (ruleset: Ruleset, mode: GameMode): GameMode => {
  if (ruleset !== 'classic') return mode;
  return mode === 'custom' ? 'classic_custom' : 'classic';
};

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

// A bare number is formatted here, once, so every tile's grouping/decimal
// rules stay consistent by construction; a caller that has already formatted
// its own value (a "45%" rate string, a formatTime() duration, a dash for
// "no record yet") passes a string or other node straight through unchanged.
const displayStatValue = (value: React.ReactNode, lang: string): React.ReactNode =>
  typeof value === 'number' ? formatInt(value, lang) : value;

const StatTile = ({ icon, value, label, tone = DEFAULT_STAT_TONE, badge }: StatTileProps) => {
  const { i18n } = useTranslation();
  return (
    <div className={`p-6 rounded-2xl border relative text-left overflow-hidden shadow-xs ${STAT_TONES[tone].surface}`}>
      <div className="absolute top-4 right-4 opacity-50">{icon}</div>
      <div className={`text-3xl font-black mt-2 ${STAT_TONES[tone].text}`}>{displayStatValue(value, i18n.language)}</div>
      <div className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-1 pr-8">{label}</div>
      {badge && <div className="text-xs font-bold mt-2">{badge}</div>}
    </div>
  );
};

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

const BigStatTile = ({ value, label, tone = DEFAULT_STAT_TONE }: BigStatTileProps) => {
  const { i18n } = useTranslation();
  return (
    <div className={`p-8 rounded-2xl border text-center shadow-xs ${STAT_TONES[tone].surface}`}>
      <div className={`text-5xl font-black mb-2 ${STAT_TONES[tone].text}`}>{displayStatValue(value, i18n.language)}</div>
      <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{label}</div>
    </div>
  );
};

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

// classicView: the classic engine deliberately never writes the Feuerwerk/x2
// bust and points attribution ("which card the chain died on" is ill-defined
// across a chain), so deriving wins/busts/avg points from those empty
// counters would present invented numbers — the two rows show how often the
// card was drawn, like the Stop row, and nothing more.
const personalCardBreakdown = (p: PersonalStats, classicView = false): CardBreakdownRow[] => [
  { card: 'Plus_Minus', labelKey: 'cards.plusMinus', labelFallback: 'Plus/Minus', count: (p.plusMinusCompleted || 0) + (p.plusMinusFailed || 0), wins: p.plusMinusCompleted || 0, fails: p.plusMinusFailed || 0 },
  { card: 'Kniffel', labelKey: 'cards.kniffel', labelFallback: 'Kniffel', count: (p.kniffelCompleted || 0) + (p.kniffelFailed || 0), wins: p.kniffelCompleted || 0, fails: p.kniffelFailed || 0 },
  { card: 'Kleeblatt', labelKey: 'cards.kleeblatt', labelFallback: 'Kleeblatt', count: (p.kleeblattCompleted || 0) + (p.kleeblattFailed || 0), wins: p.kleeblattCompleted || 0, fails: p.kleeblattFailed || 0 },
  { card: 'Stop', labelKey: 'cards.stop', labelFallback: 'Stop', count: p.skipped || 0 },
  classicView
    ? { card: 'Feuerwerk', labelKey: 'cards.feuerwerk', labelFallback: 'Feuerwerk', count: p.feuerwerkReceived || 0 }
    : { card: 'Feuerwerk', labelKey: 'cards.feuerwerk', labelFallback: 'Feuerwerk', count: p.feuerwerkReceived || 0, wins: (p.feuerwerkReceived || 0) - (p.feuerwerkBusts || 0), fails: p.feuerwerkBusts || 0, avgPoints: p.feuerwerkPointsScored || 0 },
  classicView
    ? { card: 'x2', labelKey: 'cards.x2', labelFallback: 'x2', count: p.x2Received || 0 }
    : { card: 'x2', labelKey: 'cards.x2', labelFallback: 'x2', count: p.x2Received || 0, wins: (p.x2Received || 0) - (p.x2Busts || 0), fails: p.x2Busts || 0, avgPoints: p.x2PointsScored || 0 },
];

const globalCardBreakdown = (g: GlobalStats, classicView = false): CardBreakdownRow[] => [
  // The server stores completions and totals rather than failures, so the
  // losses are the remainder — floored at zero, because the two counters are
  // written by different code paths and a mid-game crash can leave them
  // disagreeing.
  { card: 'Plus_Minus', labelKey: 'cards.plusMinus', labelFallback: 'Plus/Minus', count: g.totalPlusMinus || 0, wins: g.totalPlusMinusCompleted || 0, fails: Math.max(0, (g.totalPlusMinus || 0) - (g.totalPlusMinusCompleted || 0)) },
  { card: 'Kniffel', labelKey: 'cards.kniffel', labelFallback: 'Kniffel', count: g.totalKniffel || 0, wins: g.totalKniffelCompleted || 0, fails: Math.max(0, (g.totalKniffel || 0) - (g.totalKniffelCompleted || 0)) },
  { card: 'Kleeblatt', labelKey: 'cards.kleeblatt', labelFallback: 'Kleeblatt', count: g.totalKleeblatt || 0, wins: g.totalKleeblattCompleted || 0, fails: Math.max(0, (g.totalKleeblatt || 0) - (g.totalKleeblattCompleted || 0)) },
  { card: 'Stop', labelKey: 'cards.stop', labelFallback: 'Stop', count: g.totalStop || 0 },
  classicView
    ? { card: 'Feuerwerk', labelKey: 'cards.feuerwerk', labelFallback: 'Feuerwerk', count: g.totalFeuerwerk || 0 }
    : { card: 'Feuerwerk', labelKey: 'cards.feuerwerk', labelFallback: 'Feuerwerk', count: g.totalFeuerwerk || 0, wins: (g.totalFeuerwerk || 0) - (g.totalFeuerwerkBusts || 0), fails: g.totalFeuerwerkBusts || 0, avgPoints: g.totalFeuerwerkPoints || 0 },
  classicView
    ? { card: 'x2', labelKey: 'cards.x2', labelFallback: 'x2', count: g.totalx2 || 0 }
    : { card: 'x2', labelKey: 'cards.x2', labelFallback: 'x2', count: g.totalx2 || 0, wins: (g.totalx2 || 0) - (g.totalx2Busts || 0), fails: g.totalx2Busts || 0, avgPoints: g.totalx2Points || 0 },
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
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="flex items-center justify-between p-4 rounded-2xl bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 shadow-xs mb-3 hover:shadow-md transition-shadow"
    >
      <div className="flex items-center gap-3 flex-1">
        <span className="text-2xl">{icon}</span>
        <span className="font-bold text-gray-800 dark:text-gray-100">{label}</span>
      </div>
      <div className="flex items-center gap-6">
        <div className="text-center min-w-[40px]">
          <div className="font-black text-lg text-gray-700 dark:text-gray-200">{formatInt(count, lang)}</div>
          <div className="stat-caption">{t('statistics.total', 'Total')}</div>
        </div>
        {wins !== undefined && (
          <>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-emerald-500 dark:text-emerald-400">{formatInt(wins, lang)}</div>
              <div className="stat-caption">{t('statistics.won', 'Won')}</div>
            </div>
            <div className="text-center min-w-[40px] hidden sm:block">
              <div className="font-black text-lg text-red-500 dark:text-red-400">{formatInt(fails ?? 0, lang)}</div>
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
            <div className="font-black text-lg text-amber-500 dark:text-amber-400">{formatInt(count > 0 ? Math.round(avgPoints / count) : 0, lang)}</div>
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
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<'personal' | 'global'>('personal');
  // Which personal bucket is on screen. Games with a changed winning score or
  // deck are recorded separately and never counted anywhere else, so they need
  // somewhere of their own to be seen.
  const [mode, setMode] = useState<GameMode>(DEFAULT_GAME_MODE);
  // Which ruleset's buckets are on screen — classic games play by different
  // rules (card chains), so their numbers and records live apart.
  const [statsRuleset, setStatsRuleset] = useState<Ruleset>('modernized');

  // One useId() per mount rather than per tablist: three tablists, each
  // needing tab/panel ids that stay stable and never collide with another
  // Statistics instance (there is only ever one, but nothing here relies on
  // that). ArrowLeft/ArrowRight/Home/End are the same handler for all three
  // (useRovingTabs) — three near-identical keydown handlers would have been
  // the alternative.
  const baseId = useId();
  const topTabId = (index: 0 | 1) => `${baseId}-top-tab-${index}`;
  const topPanelId = (index: 0 | 1) => `${baseId}-top-panel-${index}`;
  const topTabs = useRovingTabs({
    count: 2,
    selectedIndex: tab === 'personal' ? 0 : 1,
    onSelect: (index) => setTab(index === 0 ? 'personal' : 'global'),
  });

  const rulesetTabId = (index: number) => `${baseId}-ruleset-tab-${index}`;
  const rulesetPanelId = `${baseId}-ruleset-panel`;
  const rulesetSelectedIndex = RULESET_TABS.findIndex(r => r.value === statsRuleset);
  const rulesetTabs = useRovingTabs({
    count: RULESET_TABS.length,
    selectedIndex: rulesetSelectedIndex,
    onSelect: (index) => setStatsRuleset(RULESET_TABS[index].value),
  });

  const modeTabId = (index: number) => `${baseId}-mode-tab-${index}`;
  const modePanelId = `${baseId}-mode-panel`;
  const modeSelectedIndex = MODE_TABS.findIndex(m => m.value === mode);
  const modeTabs = useRovingTabs({
    count: MODE_TABS.length,
    selectedIndex: modeSelectedIndex,
    onSelect: (index) => setMode(MODE_TABS[index].value),
  });

  // The personal bucket: deviceId + the selected ruleset/mode pair, via the
  // shared device-stats hook (Game.tsx's pre-game snapshot and EndScreen's
  // lifetime stats fetch the same shape the same way).
  const { stats: personalStats, status: personalStatus } = useDeviceStats<PersonalStats>(
    deviceId, bucketMode(statsRuleset, mode),
  );

  // The matching global row — not a device-stats fetch (no deviceId, a
  // different endpoint and shape entirely), so it keeps its own small
  // fetch/parse/cancel effect rather than going through the hook above.
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [globalStatus, setGlobalStatus] = useState<DeviceStatsStatus>('idle');

  useEffect(() => {
    let cancelled = false;
    // Announces the fetch about to be kicked off below, same as
    // useDeviceStats's own idle/loading transitions — there is no
    // render-time expression of "a request just started".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGlobalStatus('loading');

    void (async () => {
      try {
        const res = await fetch(`/api/stats/global?ruleset=${statsRuleset}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await parseJsonObject<GlobalStats>(res);
        if (cancelled) return;
        setGlobalStats(data);
        setGlobalStatus('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load statistics:', err);
        setGlobalStats(null);
        setGlobalStatus('error');
      }
    })();

    return () => { cancelled = true; };
  }, [statsRuleset]);

  const isSettled = (status: DeviceStatsStatus) => status === 'ready' || status === 'error';
  // A failed re-fetch (tab switch during a server hiccup) must not leave the
  // PREVIOUS bucket's numbers on screen under the new tab's label — that
  // reads as data. The failed view shows an error instead.
  const fetchFailed = personalStatus === 'error' || globalStatus === 'error';

  const [loading, setLoading] = useState(true);
  useEffect(() => {
    // Deliberately not reset to true on a later mode/ruleset switch — the
    // first render already starts in the loading state, and re-entering it
    // would replace the whole page — the tabs that were just clicked included
    // — with the spinner. The previous bucket's numbers stay put for the
    // moment the new ones take to arrive (or the error panel, if they don't).
    if (isSettled(personalStatus) && isSettled(globalStatus)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setLoading(false);
    }
  }, [personalStatus, globalStatus]);

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

  // Every comparison on this screen measures against the matching global row,
  // and that row holds that ruleset's normalized games only. In the custom
  // view there is no comparable population: no average to beat, and no record
  // that could be held.
  const isCustomView = mode === 'custom';
  // The classic view swaps the per-card turn records (ill-defined across a
  // chain) for the chain records.
  const isClassicView = statsRuleset === 'classic';
  const bustRateComparison = isCustomView ? null : compareToGlobal(pBustRateNum, gBustRateNum, true);
  const avgPtsPerTurnComparison = isCustomView ? null : compareToGlobal(pAvgPtsPerTurnNum, gAvgPtsPerTurnNum, false);
  const holdsRecord = (personal?: number | null, global?: number | null): boolean =>
    !isCustomView && isRecordHolder(personal, global);
  // Looks a RECORD_FIELDS entry up on both rows instead of naming it twice at
  // the call site — the one thing that let two tiles silently go without a
  // badge while their neighbours had one.
  const recordBadge = (field: RecordField): React.ReactNode =>
    holdsRecord(p?.[field], g?.[field]) && <RecordBadge />;

  const isOnAHotStreak = (p?.currentWinStreak || 0) >= HOT_WIN_STREAK;

  const pAvgPlayersPerGame = p?.gamesPlayed ? Math.round((p.totalPlayersSum ?? 0) / p.gamesPlayed) : 0;
  const pAvgRoundsPerGame = p?.gamesPlayed ? Math.round((p.totalRoundsSum ?? 0) / p.gamesPlayed) : 0;
  const gAvgPlayersPerGame = g?.totalGamesPlayed ? Math.round((g.totalPlayersSum ?? 0) / g.totalGamesPlayed) : 0;
  const gAvgRoundsPerGame = g?.totalGamesPlayed ? Math.round((g.totalRoundsSum ?? 0) / g.totalGamesPlayed) : 0;

  return (
    <PageContainer testId="statistics-page" className="pt-8 items-center">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full bg-white dark:bg-slate-800/80 sm:backdrop-blur-xl border border-white/40 shadow-2xl rounded-3xl px-4 pb-4 pt-8 sm:p-8 relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-2 bg-linear-to-r from-indigo-500 via-purple-500 to-pink-500" />
        <div className="flex items-center mb-8 relative justify-center">
          <button className="absolute left-0 p-3 bg-white dark:bg-slate-800 hover:bg-black/5 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-600 dark:text-gray-300 transition-colors shadow-xs" onClick={onBack} aria-label={t('common.back', 'Back')}>
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-3xl font-extrabold text-gray-800 dark:text-gray-100 flex items-center gap-3 m-0">
            <BarChart2 size={36} className="text-indigo-600" /> {t('statistics.title', 'Statistics')}
          </h1>
        </div>

        {/* Only the tiles wait for the fetch. The header above — the Back
            button with it — renders either way: a request that never settles
            used to be the whole page, leaving a browser reload as the only
            way out of this screen. */}
        {loading ? (
          <div className="flex justify-center items-center h-full min-h-[500px]">
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
              <h2 className="text-xl font-bold text-gray-700 dark:text-gray-200">{t('statistics.loading', 'Loading Statistics…')}</h2>
            </div>
          </div>
        ) : (
        <>
        {/* flex-nowrap + overflow-x-auto: below `sm:` this becomes a single
            scrollable row instead of wrapping onto a second line (C69.2).
            Centering (B10a): auto margins on the first/last child, not
            `justify-center` — the latter, used to be `sm:`-only (leaving a
            row that FITS on a phone left-aligned instead of centered), and
            turning it on unconditionally would have clipped an overflowing
            row's start (centering shifts the whole line left by half the
            overflow, which a plain scrollable flex row cannot scroll back
            into view). Auto margins only ever soak up REAL leftover space:
            a fitting row gets centred exactly as `justify-center` would,
            while an overflowing one collapses them to 0 and starts flush at
            its true left edge, still scrollable to the end. */}
        <div className="flex flex-nowrap overflow-x-auto gap-2 sm:gap-4 mb-10 [&>:first-child]:ml-auto [&>:last-child]:mr-auto" role="tablist">
          <motion.button
            ref={topTabs.setTabRef(0)}
            id={topTabId(0)}
            role="tab"
            aria-selected={tab === 'personal'}
            aria-controls={topPanelId(0)}
            tabIndex={topTabs.getTabIndex(0)}
            onKeyDown={(e) => topTabs.onKeyDown(e, 0)}
            whileTap={{ scale: 0.95 }}
            className={`shrink-0 flex items-center gap-2 px-4 py-2.5 text-sm sm:px-6 sm:py-3 sm:text-base rounded-xl font-semibold transition-all ${tab === 'personal' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-black/5 border border-gray-200 dark:border-slate-600'}`}
            onClick={() => setTab('personal')}
          >
            <User size={18} className="hidden sm:block" /> {t('statistics.personal', 'Personal')}
          </motion.button>
          <motion.button
            ref={topTabs.setTabRef(1)}
            id={topTabId(1)}
            role="tab"
            aria-selected={tab === 'global'}
            aria-controls={topPanelId(1)}
            tabIndex={topTabs.getTabIndex(1)}
            onKeyDown={(e) => topTabs.onKeyDown(e, 1)}
            whileTap={{ scale: 0.95 }}
            className={`shrink-0 flex items-center gap-2 px-4 py-2.5 text-sm sm:px-6 sm:py-3 sm:text-base rounded-xl font-semibold transition-all ${tab === 'global' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30' : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 hover:bg-black/5 border border-gray-200 dark:border-slate-600'}`}
            onClick={() => setTab('global')}
          >
            <Globe size={18} className="hidden sm:block" /> {t('statistics.globalCommunity', 'Global Community')}
          </motion.button>
        </div>

        <div className="flex flex-nowrap overflow-x-auto gap-2 sm:gap-3 mb-8 [&>:first-child]:ml-auto [&>:last-child]:mr-auto" role="tablist" data-testid="ruleset-tabs">
          {RULESET_TABS.map(({ value, labelKey, labelFallback }, index) => (
            <motion.button
              key={value}
              ref={rulesetTabs.setTabRef(index)}
              id={rulesetTabId(index)}
              role="tab"
              aria-selected={statsRuleset === value}
              aria-controls={rulesetPanelId}
              tabIndex={rulesetTabs.getTabIndex(index)}
              onKeyDown={(e) => rulesetTabs.onKeyDown(e, index)}
              whileTap={{ scale: 0.95 }}
              className={subTabClass(statsRuleset === value)}
              onClick={() => setStatsRuleset(value)}
            >
              {t(labelKey, labelFallback)}
            </motion.button>
          ))}
        </div>

        {/* Nested tabpanel: the ruleset choice is a dimension above the
            personal/global tabs it wraps (both re-fetch/re-derive off
            statsRuleset), so its own tabpanel legitimately contains theirs
            rather than sitting beside them. */}
        <div id={rulesetPanelId} role="tabpanel" aria-labelledby={rulesetTabId(rulesetSelectedIndex)}>
        {fetchFailed ? (
          <div role="alert" className="text-center text-red-500 py-10 bg-red-50 dark:bg-red-900/20 rounded-2xl border border-red-100 dark:border-red-900/50">
            {t('statistics.loadFailed', "Couldn't load these statistics — check your connection and switch tabs to retry.")}
          </div>
        ) : (
        <AnimatePresence mode="wait">
          {tab === 'personal' && (
            <motion.div key="personal" id={topPanelId(0)} role="tabpanel" aria-labelledby={topTabId(0)} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} className="flex flex-col w-full">
              <h3 className="text-xl font-bold mb-6 text-center text-gray-700 dark:text-gray-200">{t('statistics.onlineLifetimeRecord', 'Online Lifetime Record (This Device)')}</h3>

              <div className="flex flex-nowrap overflow-x-auto gap-2 sm:gap-3 mb-6 [&>:first-child]:ml-auto [&>:last-child]:mr-auto" role="tablist">
                {MODE_TABS.map(({ value, labelKey, labelFallback }, index) => (
                  <motion.button
                    key={value}
                    ref={modeTabs.setTabRef(index)}
                    id={modeTabId(index)}
                    role="tab"
                    aria-selected={mode === value}
                    aria-controls={modePanelId}
                    tabIndex={modeTabs.getTabIndex(index)}
                    onKeyDown={(e) => modeTabs.onKeyDown(e, index)}
                    whileTap={{ scale: 0.95 }}
                    className={subTabClass(mode === value)}
                    onClick={() => setMode(value)}
                  >
                    {t(labelKey, labelFallback)}
                  </motion.button>
                ))}
              </div>
              {/* Nested tabpanel, same reasoning as the ruleset one above:
                  normal/custom picks a bucket within the ALREADY-selected
                  ruleset and top-level tab, so it owns a panel inside theirs. */}
              <div id={modePanelId} role="tabpanel" aria-labelledby={modeTabId(modeSelectedIndex)}>
              {isCustomView && (
                <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-6 max-w-xl mx-auto">
                  {t('statistics.customGamesExplainer', 'Games with a changed winning score or deck. They are kept separately and never count toward your normal record or the global statistics.')}
                </p>
              )}

              {!p || !p.gamesPlayed ? (
                // B10b: the Normal/Custom empty-state strings differ in length,
                // so they can wrap onto a different number of lines on a
                // phone — min-h-52 pins the card to one height regardless
                // (generous enough for the longer string's worst-case wrap),
                // and flex/items-center/justify-center keeps the icon+message
                // pair centred within that fixed height rather than pinned to
                // the top with growing empty space below on the shorter one.
                // text-balance is what keeps EACH message's own wrap from
                // reading as ragged (a lone trailing word on its own line);
                // it does not by itself equalize the two strings' line counts.
                <div className="min-h-52 flex flex-col items-center justify-center text-center text-gray-500 dark:text-gray-400 py-10 bg-black/5 dark:bg-white/5 rounded-2xl border border-gray-100 dark:border-slate-700">
                  <div className="text-4xl mb-4">🎮</div>
                  <p className="text-balance">
                    {isCustomView
                      ? t('statistics.noCustomGames', "You haven't played any custom online games on this device yet!")
                      : t('statistics.noPersonalGames', "You haven't played any online games on this device yet!")}
                  </p>
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
                      value={isOnAHotStreak ? `🔥 ${formatInt(p.currentWinStreak || 0, i18n.language)}` : (p.currentWinStreak || 0)}
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
                    <StatTile icon={<XCircle size={32} className="text-red-400" />} value={p.pointsDeducted || 0} label={t('statistics.ptsEaten', 'Hit by −1000')} tone="red" />
                    <StatTile icon={<Clock size={32} className="text-gray-400" />} value={formatTime(p.totalPlaytime)} label={t('statistics.totalPlaytime', 'Total Playtime')} tone="neutral" />
                  </div>
                  <div className="stat-grid-3 mb-4">
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={p.busts || 0} label={t('statistics.totalBusts', 'Total Busts')} tone="red" />
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={formatFixed(p.gamesPlayed ? (p.busts || 0) / p.gamesPlayed : 0, AVG_DECIMALS, i18n.language)} label={t('statistics.avgBustsPerGame', 'Avg Busts / Game')} tone="red" />
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${pBustRate}%`} label={t('statistics.bustRate', 'Bust Rate')} tone="red" badge={<ComparisonBadge comparison={bustRateComparison} />} />
                  </div>
                  <div className="stat-grid-4 mb-4">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={p.highestTurnScore || 0} label={t('statistics.highestTurn', 'Highest Turn')} tone="yellow" badge={recordBadge('highestTurnScore')} />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={p.totalTurns ? Math.round((p.totalScore || 0) / p.totalTurns) : 0} label={t('statistics.avgPointsPerTurn', 'Avg Points/Turn')} badge={<ComparisonBadge comparison={avgPtsPerTurnComparison} />} />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={p.fastestWinTurns || '-'} label={t('statistics.fastestWinTurns', 'Fastest Win (Turns)')} tone="green" badge={recordBadge('fastestWinTurns')} />
                    <StatTile icon={<Skull size={32} className="text-red-400" />} value={p.fastestLossTurns || '-'} label={t('statistics.fastestLossTurns', 'Fastest Loss (Turns)')} tone="red" badge={recordBadge('fastestLossTurns')} />
                  </div>
                  <div className="stat-grid-4 mb-4">
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={p.mostPlayersInGame || 0} label={t('statistics.mostPlayersInGame', 'Most Players in a Game')} tone="sky" badge={recordBadge('mostPlayersInGame')} />
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={pAvgPlayersPerGame} label={t('statistics.avgPlayersPerGame', 'Avg Players/Game')} tone="sky" />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={p.longestGameRounds || 0} label={t('statistics.longestGameRounds', 'Longest Game (Rounds)')} tone="purple" badge={recordBadge('longestGameRounds')} />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={pAvgRoundsPerGame} label={t('statistics.avgRoundsPerGame', 'Avg Rounds/Game')} tone="purple" />
                  </div>
                  {isClassicView ? (
                    <div className="stat-grid-3 mb-8">
                      {/* The chain records are NULL until a chain happened —
                          a dash, because "0" would misread as a recorded
                          value (Total Tuttos is a counter; zero is honest). */}
                      <StatTile icon={<Layers size={32} className="text-orange-400" />} value={p.mostCardsInTurn ?? '–'} label={t('statistics.mostCardsInTurn', 'Most Cards in a Turn')} tone="orange" badge={recordBadge('mostCardsInTurn')} />
                      <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={p.totalTuttos || 0} label={t('statistics.totalTuttos', 'Total Tuttos')} tone="yellow" />
                      <StatTile icon={<Skull size={32} className="text-red-400" />} value={p.highestForfeitedTurnScore ?? '–'} label={t('statistics.highestForfeitedTurn', 'Biggest Turn Thrown Away')} tone="red" badge={recordBadge('highestForfeitedTurnScore')} />
                    </div>
                  ) : (
                    <div className="stat-grid-2 mb-8">
                      <StatTile icon={<Zap size={32} className="text-orange-400" />} value={p.highestFeuerwerkTurnScore || 0} label={t('statistics.highestFeuerwerkTurn', 'Highest Feuerwerk Turn')} tone="orange" badge={recordBadge('highestFeuerwerkTurnScore')} />
                      <StatTile icon={<Zap size={32} className="text-pink-400" />} value={p.highestX2TurnScore || 0} label={t('statistics.highestX2Turn', 'Highest x2 Turn')} tone="pink" badge={recordBadge('highestX2TurnScore')} />
                    </div>
                  )}
                  <CardBreakdown rows={personalCardBreakdown(p, isClassicView)} />
                </div>
              )}
              </div>
            </motion.div>
          )}

          {tab === 'global' && (
            <motion.div key="global" id={topPanelId(1)} role="tabpanel" aria-labelledby={topTabId(1)} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="flex flex-col w-full">
              <div className="text-center mb-8">
                <h3 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-2">{t('statistics.globalCommunityTitle', 'Global Community Statistics')}</h3>
                <p className="text-gray-500 dark:text-gray-400 font-medium">{t('statistics.globalDescription', 'Aggregated across all normal online games played.')}</p>
                {/* Custom games are recorded as nothing but this count — see
                    updateGlobalStats. Saying so is what keeps the totals above
                    from reading as "every game ever played". */}
                {!!g?.customGamesPlayed && (
                  <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
                    {t('statistics.customGamesNotCounted', 'Custom games played: {{played}} (not counted here)', { played: formatInt(g.customGamesPlayed ?? 0, i18n.language) })}
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
                  <div className="stat-grid-4 mb-4">
                    <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={g.highestTurnScore || 0} label={t('statistics.highestTurnGlobal', 'Highest Turn (Global)')} tone="yellow" />
                    <StatTile icon={<TrendingUp size={32} className="text-indigo-400" />} value={g.totalTurns ? Math.round((g.totalScore || 0) / g.totalTurns) : 0} label={t('statistics.avgPointsPerTurn', 'Avg Points/Turn')} />
                    <StatTile icon={<FastForward size={32} className="text-green-400" />} value={g.fastestWinTurns || '-'} label={t('statistics.fastestWinTurns', 'Fastest Win (Turns)')} tone="green" />
                    <StatTile icon={<Skull size={32} className="text-red-400" />} value={g.fastestLossTurns || '-'} label={t('statistics.fastestLossTurns', 'Fastest Loss (Turns)')} tone="red" />
                  </div>
                  <div className="stat-grid-4 mb-4">
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={g.mostPlayersInGame || 0} label={t('statistics.mostPlayersInGame', 'Most Players in a Game')} tone="sky" />
                    <StatTile icon={<Hash size={32} className="text-sky-400" />} value={gAvgPlayersPerGame} label={t('statistics.avgPlayersPerGame', 'Avg Players/Game')} tone="sky" />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={g.longestGameRounds || 0} label={t('statistics.longestGameRounds', 'Longest Game (Rounds)')} tone="purple" />
                    <StatTile icon={<Repeat size={32} className="text-purple-400" />} value={gAvgRoundsPerGame} label={t('statistics.avgRoundsPerGame', 'Avg Rounds/Game')} tone="purple" />
                  </div>
                  {isClassicView ? (
                    <div className="stat-grid-3 mb-4">
                      <StatTile icon={<Layers size={32} className="text-orange-400" />} value={g.mostCardsInTurn ?? '–'} label={t('statistics.mostCardsInTurn', 'Most Cards in a Turn')} tone="orange" />
                      <StatTile icon={<Zap size={32} className="text-yellow-400" />} value={g.totalTuttos || 0} label={t('statistics.totalTuttos', 'Total Tuttos')} tone="yellow" />
                      <StatTile icon={<Skull size={32} className="text-red-400" />} value={g.highestForfeitedTurnScore ?? '–'} label={t('statistics.highestForfeitedTurn', 'Biggest Turn Thrown Away')} tone="red" />
                    </div>
                  ) : (
                    <div className="stat-grid-2 mb-4">
                      <StatTile icon={<Zap size={32} className="text-orange-400" />} value={g.highestFeuerwerkTurnScore || 0} label={t('statistics.highestFeuerwerkTurn', 'Highest Feuerwerk Turn')} tone="orange" />
                      <StatTile icon={<Zap size={32} className="text-pink-400" />} value={g.highestX2TurnScore || 0} label={t('statistics.highestX2Turn', 'Highest x2 Turn')} tone="pink" />
                    </div>
                  )}
                  <div className="stat-grid-3 mb-8">
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={g.totalBusts || 0} label={t('statistics.totalBusts', 'Total Busts')} tone="red" />
                    <StatTile icon={<Hash size={32} className="text-red-400" />} value={formatFixed(g.totalGamesPlayed ? (g.totalBusts || 0) / g.totalGamesPlayed : 0, AVG_DECIMALS, i18n.language)} label={t('statistics.avgBustsPerGame', 'Avg Busts / Game')} tone="red" />
                    <StatTile icon={<TrendingDown size={32} className="text-red-400" />} value={`${gBustRate}%`} label={t('statistics.globalBustRate', 'Global Bust Rate')} tone="red" />
                  </div>
                  <CardBreakdown rows={globalCardBreakdown(g, isClassicView)} />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        )}
        </div>
        </>
        )}
      </motion.div>
    </PageContainer>
  );
}
