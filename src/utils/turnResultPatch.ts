import { MAX_HISTORY_LOG_SIZE, type CoreGameState, type HistoryEntry, type NextTurnResult, type Player } from '../types';

type ChartPatch = {
  chartValues: number[][];
  chartLabels: number[];
};

type TurnResultPatchState = Pick<CoreGameState, 'historyLog' | 'round'> & {
  chartValues: number[][];
  chartLabels: number[];
};

export type TurnResultPatch = {
  players: Player[];
  previousCard: NextTurnResult['previousCard'];
  previousScore: NextTurnResult['previousScore'];
  previousLeaders: NextTurnResult['previousLeaders'];
  previousWasBust: NextTurnResult['previousWasBust'];
  previousWasSuccess: NextTurnResult['previousWasSuccess'];
  previousHighestTurnScore: NextTurnResult['previousHighestTurnScore'];
  previousHighestFeuerwerkTurnScore: NextTurnResult['previousHighestFeuerwerkTurnScore'];
  previousHighestX2TurnScore: NextTurnResult['previousHighestX2TurnScore'];
  previousPlayerName: NextTurnResult['previousPlayerName'];
  previousTurnSummary: NextTurnResult['previousTurnSummary'];
  liveTurnState: null;
  historyLog: HistoryEntry[];
} & Partial<ChartPatch>;

export const appendRoundChartPoint = (
  chartValues: number[][],
  chartLabels: number[],
  players: readonly Pick<Player, 'score'>[],
  round: number,
  maxChartPoints: number | null,
): ChartPatch | null => {
  // chartLabels is round-indexed and chartValues is player-indexed, so labels
  // only append when the matching score rows append too.
  if (chartValues.length !== players.length) return null;
  if (maxChartPoints !== null && chartLabels.length >= maxChartPoints) return null;
  return {
    chartValues: chartValues.map((series, index) => [...series, players[index].score]),
    chartLabels: [...chartLabels, round],
  };
};

export const buildTurnResultPatch = (
  state: TurnResultPatchState,
  result: NextTurnResult,
  maxChartPoints: number | null,
): TurnResultPatch => {
  const chartPatch = result.isRoundEnd
    ? appendRoundChartPoint(state.chartValues, state.chartLabels, result.players, state.round, maxChartPoints)
    : null;
  return {
    players: result.players,
    previousCard: result.previousCard,
    previousScore: result.previousScore,
    previousLeaders: result.previousLeaders,
    previousWasBust: result.previousWasBust,
    previousWasSuccess: result.previousWasSuccess,
    previousHighestTurnScore: result.previousHighestTurnScore,
    previousHighestFeuerwerkTurnScore: result.previousHighestFeuerwerkTurnScore,
    previousHighestX2TurnScore: result.previousHighestX2TurnScore,
    previousPlayerName: result.previousPlayerName,
    previousTurnSummary: result.previousTurnSummary,
    liveTurnState: null,
    // Keep a fresh bounded history. When the cap drops the oldest entry, undo
    // can still pop the newest turn but cannot restore the shifted entry.
    historyLog: [...state.historyLog, result.historyEntry].slice(-MAX_HISTORY_LOG_SIZE),
    ...(chartPatch ?? {}),
  };
};
