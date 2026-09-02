import { useEffect, useMemo, useState, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { Line } from 'react-chartjs-2';
import confetti from 'canvas-confetti';
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
import { Trophy, RotateCcw, Settings, Award, Zap, TrendingDown, Layers, Skull } from 'lucide-react';
import { formatTime } from '../utils/formatTime';
import { gameModeOf, isCustomGameMode } from '../utils/statsApi';
import { MIN_ONLINE_PLAYERS } from '../utils/configValidation';
import { computeRankedPlayers, getLeaders } from '../utils/coreGameEngine';
import { motion } from 'framer-motion';
import { useGameStore } from '../store/useGameStore';
import type { Player, DeviceStatsRow } from '../types';
import './EndScreen.css';
import { readableNameVars } from '../utils/contrastColor';
import {
  useDeviceStats,
  STATS_FETCH_MAX_RETRIES, STATS_FETCH_RETRY_DELAY_MS, STATS_FETCH_INITIAL_DELAY_MS,
  type DeviceStatsRetryOptions,
} from '../hooks/useDeviceStats';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const colors = [
  '#FF5733', '#33FF57', '#3357FF', '#F033FF', '#33FFF0',
  '#FFD700', '#FF33A1', '#8D33FF', '#33FF8D', '#FF8D33',
];

// Re-exported so this screen's existing retry-lifecycle tests keep importing
// them from here — the constants themselves now live next to the hook.
export { STATS_FETCH_MAX_RETRIES, STATS_FETCH_RETRY_DELAY_MS, STATS_FETCH_INITIAL_DELAY_MS };

// The subset of this device's DeviceStatsRow the end screen reads.
type DeviceStats =
  & Pick<DeviceStatsRow, 'gamesPlayed' | 'wins' | 'pointsDeducted' | 'kniffelCompleted'>
  & Partial<Pick<DeviceStatsRow, 'busts' | 'currentWinStreak' | 'bestWinStreak'>>;

// The lifetime-stats fetch races the server-side stats write triggered by the
// same game finish, so it retries until gamesPlayed shows up (or gives up).
// A module-level constant, not built inline in the component: it sits in
// useDeviceStats's effect dependency array, so a fresh object every render
// would restart the fetch every render.
const LIFETIME_STATS_RETRY: DeviceStatsRetryOptions<DeviceStats> = {
  maxRetries: STATS_FETCH_MAX_RETRIES,
  retryDelayMs: STATS_FETCH_RETRY_DELAY_MS,
  initialDelayMs: STATS_FETCH_INITIAL_DELAY_MS,
  shouldRetry: (data) => !data?.gamesPlayed,
};

interface EndScreenProps {
  theme: string;
  deviceId: string;
}

export default function EndScreen({ theme, deviceId }: EndScreenProps) {
  const { t } = useTranslation();
  // Narrowed to only the fields this screen reads, with shallow equality —
  // EndScreen only mounts briefly at game-over, but a whole-store subscription
  // would still re-render it (and re-run confetti-adjacent effects) on every
  // unrelated store mutation (toasts, reactions) while it's on screen.
  const game = useGameStore(useShallow(state => ({
    players: state.players,
    round: state.round,
    gameTimeInSeconds: state.gameTimeInSeconds,
    startGame: state.startGame,
    endGame: state.endGame,
    chartLabels: state.chartLabels,
    chartNames: state.chartNames,
    chartValues: state.chartValues,
    leaveRoom: state.leaveRoom,
    myName: state.myName,
    preGameStats: state.preGameStats,
    isOnline: state.isOnline,
    isHost: state.isHost,
    winningScore: state.winningScore,
    initialCards: state.initialCards,
    ruleset: state.ruleset,
  })));
  const { players, round, gameTimeInSeconds, startGame, endGame, chartLabels, chartNames, chartValues, leaveRoom, myName, preGameStats } = game;

  const snapshotRef = useRef<Player[]>(players);
  const [playerSnapshot, setPlayerSnapshot] = useState<Player[]>(players);
  // The chart trio is spliced in lockstep with the live roster server-side —
  // so it must freeze WITH the roster snapshot, or a departing player's line
  // silently vanishes from the score chart while the frozen table beside it
  // still lists them.
  const [chartSnapshot, setChartSnapshot] = useState(() => ({ chartValues, chartNames, chartLabels }));

  useEffect(() => {
    if (players.length >= snapshotRef.current.length) {
      snapshotRef.current = players;
      setPlayerSnapshot(players);
      setChartSnapshot({ chartValues, chartNames, chartLabels });
    }
  }, [players, chartValues, chartNames, chartLabels]);

  const sortedPlayers = computeRankedPlayers(playerSnapshot);
  const winner = sortedPlayers[0];
  const formattedTime = formatTime(gameTimeInSeconds);

  // Which bucket the game that just ended was recorded in. The lifetime block
  // below shows that bucket's numbers, so a custom game's totals are never
  // presented as the player's record.
  const gameMode = gameModeOf({ winningScore: game.winningScore, initialCards: game.initialCards }, game.ruleset);
  const isCustomGame = isCustomGameMode(gameMode);

  // "Did I set a new personal record this game?" — compared against the
  // snapshot fetched when the game STARTED (game.preGameStats, see Game.tsx),
  // not the post-game deviceStats fetched below (which already includes this
  // game's own contribution and so can't tell a genuine new record apart from
  // merely tying an older one — see the plan notes for this feature).
  const me = playerSnapshot.find(p => p.name === myName);
  const isWinner = !!me && getLeaders(playerSnapshot).some(l => l.name === me.name);
  const newHighScore = !!(preGameStats && me && me.highestTurnScore && me.highestTurnScore > (preGameStats.highestTurnScore ?? 0));
  // totalTurns > 0 on both: these records count turns taken, so a seat that
  // never got one (the game ended before the round came round) compares 0
  // against every stored record and "beats" it — a personal best in a game
  // the player took no part in.
  const newFastestWin = !!(preGameStats && me && isWinner && me.totalTurns > 0
    && (preGameStats.fastestWinTurns == null || me.totalTurns < preGameStats.fastestWinTurns));
  const newFastestLoss = !!(preGameStats && me && !isWinner && me.totalTurns > 0
    && (preGameStats.fastestLossTurns == null || me.totalTurns < preGameStats.fastestLossTurns));
  const newHighestFeuerwerk = !!(preGameStats && me?.highestFeuerwerkTurnScore
    && me.highestFeuerwerkTurnScore > (preGameStats.highestFeuerwerkTurnScore ?? 0));
  const newHighestX2 = !!(preGameStats && me?.highestX2TurnScore
    && me.highestX2TurnScore > (preGameStats.highestX2TurnScore ?? 0));
  // The classic pair. The engine writes them on the classic branch only, so
  // in a modernized game they are undefined and the leading truthiness check
  // is what keeps an absent value from "beating" a stored one.
  const newMostCards = !!(preGameStats && me?.mostCardsInTurn
    && me.mostCardsInTurn > (preGameStats.mostCardsInTurn ?? 0));
  const newHighestForfeited = !!(preGameStats && me?.highestForfeitedTurnScore
    && me.highestForfeitedTurnScore > (preGameStats.highestForfeitedTurnScore ?? 0));
  // A custom game cannot set a personal best: it is recorded in its own bucket,
  // and the snapshot these compare against is never even fetched for one (see
  // Game.tsx) — so celebrating here would announce a record against nothing.
  const hasNewRecord = !isCustomGame &&
    (newHighScore || newFastestWin || newFastestLoss || newHighestFeuerwerk || newHighestX2
      || newMostCards || newHighestForfeited);

  // Same rule as the lobby's StartGameButton: don't let the host restart while
  // someone is disconnected — their turns would just burn down via the server
  // turn timer until they reconnect or get kicked. Checked against the LIVE
  // roster (not the frozen end-screen snapshot) so it clears on reconnect.
  const waitingForReconnect = game.isOnline && players.some(p => p.disconnected);
  // A leaver is spliced out of the roster server-side (not marked
  // disconnected), so waitingForReconnect never sees them — the lobby's
  // player minimum must be held here too, or Play Again could start the
  // 1-player online game the lobby forbids (a guaranteed stats-farming
  // "win"). Checked against the LIVE roster for the same reason as above.
  const tooFewForRematch = game.isOnline && players.length < MIN_ONLINE_PLAYERS;
  const playAgainBlocked = waitingForReconnect || tooFewForRematch;

  // Local games never submit stats (by design — see useGameStore.nextTurn),
  // so the retry loop would always exhaust its attempts waiting for
  // gamesPlayed > 0, wasting requests and time for nothing.
  const { stats: deviceStats } = useDeviceStats<DeviceStats>(
    deviceId, gameMode,
    { enabled: game.isOnline, retry: LIFETIME_STATS_RETRY },
  );

  // Fires once per mount (EndScreen only mounts when a game just finished —
  // see App.tsx's finished/status-gated rendering), so this can't double-fire
  // from the playerSnapshot/deviceStats effects re-rendering above.
  useEffect(() => {
    confetti({ particleCount: 150, spread: 100, origin: { y: 0.4 } });
  }, []);

  const textColor = theme === 'dark' ? '#f8fafc' : '#1a1a1a';
  const gridColor = theme === 'dark' ? '#334155' : '#e5e7eb';

  // Bind each line to the player that owns the data series (players[i] is
  // index-aligned with chartValues[i]), so the name and color stay in sync with
  // the leaderboard even after the start-of-game shuffle or custom color picks.
  // chartNames is kept only as a defensive fallback. Memoized so unrelated
  // re-renders (e.g. deviceStats arriving) don't hand react-chartjs-2 a new
  // object identity every time and defeat its internal diffing.
  const chartData = useMemo(() => ({
    labels: chartSnapshot.chartLabels,
    datasets: chartSnapshot.chartValues.map((data, i) => {
      // The frozen roster is index-aligned with the frozen series — both were
      // captured in the same snapshot, so a departure can't shift either.
      const player = playerSnapshot[i];
      const fallback = colors[i % colors.length];
      return {
        label: player?.name ?? chartSnapshot.chartNames[i] ?? `Player ${i + 1}`,
        data: data ?? [],
        borderColor: player?.color ?? fallback,
        backgroundColor: player?.color ?? fallback,
        tension: 0.2,
      };
    }),
  }), [chartSnapshot, playerSnapshot]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' as const, labels: { color: textColor } },
      title: { display: true, text: t('end.scorePerRound', 'Score per Round'), color: textColor },
    },
    scales: {
      y: { ticks: { color: textColor }, grid: { color: gridColor } },
      x: { ticks: { color: textColor }, grid: { color: gridColor } },
    },
  }), [textColor, gridColor, t]);

  if (!winner) return null;

  return (
    <div data-testid="end-screen-page" className="container mx-auto px-2 sm:px-4 py-4 sm:py-8 pb-20 max-w-3xl flex flex-col gap-4 sm:gap-8">
      <motion.div initial={{ opacity: 0, y: 20, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-2xl rounded-3xl p-6 sm:p-10 text-center">
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', damping: 10, stiffness: 100, delay: 0.2 }} className="flex justify-center mb-6">
          <div className="bg-amber-100 p-6 rounded-full shadow-lg border-4 border-amber-300">
            <Trophy size={64} className="text-amber-500" />
          </div>
        </motion.div>

        <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-linear-to-r from-amber-500 to-orange-600 mb-8 break-words">
          {t('end.winner', 'Winner:')} {winner.name}
        </h1>

        <div className="flex flex-wrap justify-center gap-6 mb-10">
          <div className="bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-slate-600 rounded-2xl p-6 min-w-[180px] shadow-xs">
            <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{t('end.playedRounds', 'Played Rounds')}</div>
            <div className="text-4xl font-black accent-number">{round}</div>
          </div>
          <div className="bg-black/5 dark:bg-white/5 border border-gray-200 dark:border-slate-600 rounded-2xl p-6 min-w-[180px] shadow-xs">
            <div className="text-sm font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{t('end.playtime', 'Playtime')}</div>
            <div className="text-4xl font-black accent-number">{formattedTime}</div>
          </div>
        </div>

        <div className="flex justify-center">
          {(!game.isOnline || game.isHost) ? (
            <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
              <motion.button
                whileHover={!playAgainBlocked ? { scale: 1.05 } : {}}
                whileTap={!playAgainBlocked ? { scale: 0.95 } : {}}
                className={`flex-1 py-4 px-6 rounded-2xl text-xl font-bold flex justify-center items-center gap-2 transition-colors ${playAgainBlocked ? 'bg-gray-400 text-gray-200 cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg shadow-emerald-500/30'}`}
                onClick={startGame}
                disabled={playAgainBlocked}
              >
                <RotateCcw size={24} /> {waitingForReconnect
                  ? t('lobby.waitingForPlayersToReconnect', 'Waiting for players to reconnect...')
                  : tooFewForRematch
                    ? t('end.tooFewPlayers', 'Not enough players to play again')
                    : t('end.playAgain', 'Play Again')}
              </motion.button>
              <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="flex-1 bg-white dark:bg-slate-800 hover:bg-black/5 text-gray-700 dark:text-gray-200 border-2 border-gray-200 dark:border-slate-600 py-4 px-6 rounded-2xl text-lg font-bold flex justify-center items-center gap-2 shadow-xs transition-colors" onClick={endGame}>
                <Settings size={20} /> {t('end.newConfig', 'New Config')}
              </motion.button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 bg-black/5 dark:bg-white/5 p-6 rounded-2xl border border-gray-200 dark:border-slate-600 w-full max-w-md">
              <div className="text-indigo-600 font-bold text-lg flex items-center gap-3">
                <div className="w-6 h-6 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
                {t('end.waitingForHost', 'Waiting for host to restart...')}
              </div>
              <button className="text-red-500 hover:text-red-700 hover:bg-red-50 px-6 py-2 rounded-lg font-bold transition-colors border border-red-200" onClick={leaveRoom}>
                {t('end.leaveGame', 'Leave Game')}
              </button>
            </div>
          )}
        </div>
      </motion.div>

      {hasNewRecord && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl p-6 sm:p-8">
          <h3 className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-gray-100 text-center mb-6">{t('end.newRecordsTitle', 'New Personal Records!')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 max-w-2xl mx-auto">
            {newHighScore && (
              <div className="flex items-center gap-4 bg-amber-50 dark:bg-amber-900/20 rounded-2xl p-4 border border-amber-100 dark:border-amber-800">
                <Award size={36} className="text-amber-500 shrink-0" />
                <div>
                  <div className="text-2xl font-black text-amber-600 dark:text-amber-400">{me?.highestTurnScore}</div>
                  <div className="end-record-label">{t('end.newPersonalBestTurnScore', 'New Personal Best Turn Score!')}</div>
                </div>
              </div>
            )}
            {newFastestWin && (
              <div className="flex items-center gap-4 bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl p-4 border border-emerald-100 dark:border-emerald-800">
                <Zap size={36} className="text-emerald-500 shrink-0" />
                <div>
                  <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">{me?.totalTurns}</div>
                  <div className="end-record-label">{t('end.newFastestWin', 'New Fastest Win (turns)!')}</div>
                </div>
              </div>
            )}
            {newFastestLoss && (
              <div className="flex items-center gap-4 bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-100 dark:border-red-800">
                <TrendingDown size={36} className="text-red-500 shrink-0" />
                <div>
                  <div className="text-2xl font-black text-red-600 dark:text-red-400">{me?.totalTurns}</div>
                  <div className="end-record-label">{t('end.newFastestLoss', 'New Fastest Loss (turns) — ouch!')}</div>
                </div>
              </div>
            )}
            {newHighestFeuerwerk && (
              <div className="flex items-center gap-4 bg-orange-50 dark:bg-orange-900/20 rounded-2xl p-4 border border-orange-100 dark:border-orange-800">
                <Award size={36} className="text-orange-500 shrink-0" />
                <div>
                  <div className="text-2xl font-black text-orange-600 dark:text-orange-400">{me?.highestFeuerwerkTurnScore}</div>
                  <div className="end-record-label">{t('end.newHighestFeuerwerk', 'New Personal Best Feuerwerk Turn!')}</div>
                </div>
              </div>
            )}
            {newHighestX2 && (
              <div className="flex items-center gap-4 bg-pink-50 dark:bg-pink-900/20 rounded-2xl p-4 border border-pink-100 dark:border-pink-800">
                <Award size={36} className="text-pink-500 shrink-0" />
                <div>
                  <div className="text-2xl font-black text-pink-600 dark:text-pink-400">{me?.highestX2TurnScore}</div>
                  <div className="end-record-label">{t('end.newHighestX2', 'New Personal Best x2 Turn!')}</div>
                </div>
              </div>
            )}
            {newMostCards && (
              <div className="flex items-center gap-4 bg-orange-50 dark:bg-orange-900/20 rounded-2xl p-4 border border-orange-100 dark:border-orange-800">
                <Layers size={36} className="text-orange-500 shrink-0" />
                <div>
                  <div className="text-2xl font-black text-orange-600 dark:text-orange-400">{me?.mostCardsInTurn}</div>
                  <div className="end-record-label">{t('end.newMostCardsInTurn', 'New Longest Chain (cards)!')}</div>
                </div>
              </div>
            )}
            {newHighestForfeited && (
              <div className="flex items-center gap-4 bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-100 dark:border-red-800">
                <Skull size={36} className="text-red-500 shrink-0" />
                <div>
                  <div className="text-2xl font-black text-red-600 dark:text-red-400">{me?.highestForfeitedTurnScore}</div>
                  <div className="end-record-label">{t('end.newHighestForfeitedTurn', 'Biggest Turn Ever Thrown Away — ouch!')}</div>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {deviceStats && deviceStats.gamesPlayed > 0 && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl p-6 sm:p-8">
          <h3 className={`text-xl sm:text-2xl font-bold text-gray-800 dark:text-gray-100 text-center ${isCustomGame ? 'mb-2' : 'mb-6 sm:mb-8'}`}>{t('end.lifetimeStats', 'Your Lifetime Statistics')}</h3>
          {/* The numbers below are the custom bucket's, not the player's
              record — saying so is what keeps them from being read as one. */}
          {isCustomGame && (
            <p className="text-sm text-center text-gray-500 dark:text-gray-400 mb-6 sm:mb-8">
              {t('end.customGameNotice', 'Custom game — counted under Custom in your statistics, not toward your normal record.')}
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 text-center max-w-3xl mx-auto">
            <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl p-4 border border-indigo-100 dark:border-indigo-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black accent-number mb-1">{deviceStats.gamesPlayed}</div>
              <div className="end-stat-label">{t('end.gamesPlayed', 'Games Played')}</div>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl p-4 border border-emerald-100 dark:border-emerald-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black text-emerald-500 mb-1">{deviceStats.wins}</div>
              <div className="end-stat-label">{t('end.totalWins', 'Total Wins')}</div>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-100 dark:border-red-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black text-red-500 mb-1">{deviceStats.pointsDeducted}</div>
              <div className="end-stat-label">{t('end.pointsEaten', '-1000 Pts Eaten')}</div>
            </div>
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-2xl p-4 border border-amber-100 dark:border-amber-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black text-amber-500 mb-1">{deviceStats.kniffelCompleted}</div>
              <div className="end-stat-label">{t('end.kniffelsDone', 'Kniffels Done')}</div>
            </div>
            <div className="bg-orange-50 dark:bg-orange-900/20 rounded-2xl p-4 border border-orange-100 dark:border-orange-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black text-orange-500 mb-1">{deviceStats.busts || 0}</div>
              <div className="end-stat-label">{t('end.totalBusts', 'Total Busts')}</div>
            </div>
            <div className="bg-orange-50 dark:bg-orange-900/20 rounded-2xl p-4 border border-orange-100 dark:border-orange-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black text-orange-500 mb-1">{((deviceStats.busts || 0) / Math.max(1, deviceStats.gamesPlayed)).toFixed(1)}</div>
              <div className="end-stat-label">{t('end.avgBustsPerGame', 'Avg Busts/Game')}</div>
            </div>
            <div className="bg-violet-50 dark:bg-violet-900/20 rounded-2xl p-4 border border-violet-100 dark:border-violet-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black text-violet-500 mb-1">{deviceStats.currentWinStreak || 0}</div>
              <div className="end-stat-label">{t('end.currentWinStreak', 'Current Win Streak')}</div>
            </div>
            <div className="bg-violet-50 dark:bg-violet-900/20 rounded-2xl p-4 border border-violet-100 dark:border-violet-800 flex flex-col justify-center">
              <div className="text-3xl sm:text-4xl font-black text-violet-500 mb-1">{deviceStats.bestWinStreak || 0}</div>
              <div className="end-stat-label">{t('end.bestWinStreak', 'Best Win Streak')}</div>
            </div>
          </div>
        </motion.div>
      )}

      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl p-8 overflow-hidden">
        <h3 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-6">{t('end.gameStats', 'Game Statistics')}</h3>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-slate-600">
          <div className="flex flex-col rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 min-w-max">
            <div className="flex border-b border-gray-200 dark:border-slate-600 bg-black/5 dark:bg-white/5">
              <div className="p-4 w-56 shrink-0 font-bold text-gray-600 dark:text-gray-300">{t('end.stat', 'Stat')}</div>
              {sortedPlayers.map(p => (
                <div key={p.id ?? p.name} className="player-name p-4 w-32 shrink-0 font-bold text-center truncate" style={readableNameVars(p.color)} title={p.name}>{p.name}</div>
              ))}
            </div>
            <div className="flex flex-col">
              {[
                { label: t('end.position', 'Position'), render: (p: Player) => `${p.position}.` },
                { label: t('end.score', 'Score'), render: (p: Player) => <span className="font-black accent-number">{p.score}</span> },
                { label: t('end.totalTurns', 'Total Turns'), render: (p: Player) => p.totalTurns },
                { label: t('end.busts', 'Busts'), render: (p: Player) => <span className="text-red-500 font-bold">{p.busts}</span> },
                // The chain record of the game that just ended — a classic-only
                // concept (modernized turns are always exactly one card). A dash
                // marks a player who never got a turn: the record is genuinely
                // absent there, not zero.
                ...(game.ruleset === 'classic' ? [
                  { label: t('end.mostCardsInTurn', 'Most Cards in a Turn'), render: (p: Player) => <span className="font-bold text-indigo-500">{p.mostCardsInTurn ?? '–'}</span> },
                ] : []),
                { label: t('end.avgPtsPerRound', 'Avg Pts / Round'), render: (p: Player) => <span className="font-bold text-emerald-500">{Math.round(p.score / Math.max(1, round))}</span> },
                { label: t('end.pointsEatenStat', '-1000 Points Eaten'), render: (p: Player) => p.times1000PointsDeducted },
                { label: t('end.plusMinusStat', 'Plus/Minus (Success/Fail)'), render: (p: Player) => <span><span className="text-emerald-500">{p.timesPlusMinusCompleted}</span> / <span className="text-red-500">{p.timesPlusMinusFailed}</span></span> },
                { label: t('end.kniffelStat', 'Kniffel (Success/Fail)'), render: (p: Player) => <span><span className="text-emerald-500">{p.timesKniffelCompleted}</span> / <span className="text-red-500">{p.timesKniffelFailed}</span></span> },
                { label: t('end.skipped', 'Skipped'), render: (p: Player) => p.timesSkipped },
                // Classic never attributes points to the Feuerwerk card (the
                // engine's summary path skips it, same as the Statistics
                // breakdown) — the row shows draws only instead of an
                // invented "0 points".
                game.ruleset === 'classic'
                  ? { label: t('end.feuerwerkReceivedStat', 'Feuerwerk (Received)'), render: (p: Player) => p.timesFeuerwerkReceived ?? 0 }
                  : { label: t('end.feuerwerkStat', 'Feuerwerk (Received/Pts)'), render: (p: Player) => <span>{p.timesFeuerwerkReceived} / <span className="text-amber-500 font-bold">{p.feuerwerkPointsScored || 0}</span></span> },
              ].map(({ label, render }) => (
                <div key={label} className="flex border-b border-gray-100 dark:border-slate-700/50 last:border-0 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                  <div className="p-4 w-56 shrink-0 font-medium text-gray-600 dark:text-gray-300">{label}</div>
                  {sortedPlayers.map(p => (
                    <div key={p.id ?? p.name} className="p-4 w-32 shrink-0 text-center">{render(p)}</div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </motion.div>

      {chartSnapshot.chartLabels && chartSnapshot.chartLabels.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="bg-white dark:bg-slate-800/80 backdrop-blur-xl border border-white/40 shadow-xl rounded-3xl p-8 h-[400px]">
          <Line data={chartData} options={chartOptions} />
        </motion.div>
      )}
    </div>
  );
}
