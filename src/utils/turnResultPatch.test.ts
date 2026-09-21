/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { MAX_HISTORY_LOG_SIZE, type CoreGameState, type HistoryEntry, type NextTurnResult, type Player } from '../types';
import { makeGameState, makePlayer } from '../testing/factories';
import { appendRoundChartPoint, buildTurnResultPatch } from './turnResultPatch';

const CURRENT_ROUND = 4;
const SERVER_CHART_CAP = 2;
const LOCAL_UNCAPPED = null;

const historyEntry = (id: string, round = CURRENT_ROUND): HistoryEntry => ({
  id,
  round,
  playerName: 'Alice',
  card: '200',
  type: 'success',
  score: 300,
});

const resultPlayers = (): Player[] => [
  makePlayer({ name: 'Alice', score: 900 }),
  makePlayer({ name: 'Bob', score: 1200 }),
];

const nextTurnResult = (overrides: Partial<NextTurnResult> = {}): NextTurnResult => ({
  players: resultPlayers(),
  isGameOver: false,
  isRoundEnd: true,
  nextIndex: 0,
  nextRound: CURRENT_ROUND + 1,
  previousCard: '200',
  previousScore: 300,
  previousLeaders: [makePlayer({ name: 'Bob', score: 1200 })],
  previousWasBust: false,
  previousWasSuccess: true,
  previousHighestTurnScore: 300,
  previousHighestFeuerwerkTurnScore: 0,
  previousHighestX2TurnScore: 0,
  previousPlayerName: 'Alice',
  previousTurnSummary: null,
  newDeck: ['300'],
  drawnCard: '300',
  historyEntry: historyEntry('new-entry'),
  ...overrides,
});

type PatchState = CoreGameState & {
  chartValues: number[][];
  chartLabels: number[];
  liveTurnState: unknown;
};

const patchState = (overrides: Partial<PatchState> = {}): PatchState => ({
  ...makeGameState({
    round: CURRENT_ROUND,
    players: [makePlayer({ name: 'Alice' }), makePlayer({ name: 'Bob' })],
    historyLog: [historyEntry('old-entry', CURRENT_ROUND - 1)],
  }),
  chartValues: [[10], [20]],
  chartLabels: [CURRENT_ROUND - 1],
  liveTurnState: { turnScore: 300 },
  ...overrides,
});

const freezeChartValues = (chartValues: number[][]): number[][] => {
  chartValues.forEach(series => Object.freeze(series));
  return Object.freeze(chartValues) as number[][];
};

const freezeHistoryLog = (entries: HistoryEntry[]): HistoryEntry[] => {
  entries.forEach(entry => Object.freeze(entry));
  return Object.freeze(entries) as HistoryEntry[];
};

const freezePlayers = (players: Player[]): Player[] => {
  players.forEach(player => Object.freeze(player));
  return Object.freeze(players) as Player[];
};

const freezePatchState = (state: PatchState): PatchState => {
  freezeHistoryLog(state.historyLog);
  freezeChartValues(state.chartValues);
  Object.freeze(state.chartLabels);
  if (state.liveTurnState && typeof state.liveTurnState === 'object') Object.freeze(state.liveTurnState);
  return Object.freeze(state) as PatchState;
};

const freezeNextTurnResult = (result: NextTurnResult): NextTurnResult => {
  freezePlayers(result.players);
  if (result.previousLeaders) freezePlayers(result.previousLeaders);
  Object.freeze(result.historyEntry);
  return Object.freeze(result) as NextTurnResult;
};

describe('appendRoundChartPoint', () => {
  it('appends one immutable datapoint per player when the series match the roster', () => {
    const chartValues = freezeChartValues([[10], [20]]);
    const chartLabels = Object.freeze([CURRENT_ROUND - 1]) as number[];
    const players = resultPlayers();

    const patch = appendRoundChartPoint(chartValues, chartLabels, players, CURRENT_ROUND, SERVER_CHART_CAP);
    const secondPatch = appendRoundChartPoint(chartValues, chartLabels, players, CURRENT_ROUND, SERVER_CHART_CAP);

    expect(patch).toEqual({ chartValues: [[10, 900], [20, 1200]], chartLabels: [CURRENT_ROUND - 1, CURRENT_ROUND] });
    expect(patch?.chartValues).not.toBe(chartValues);
    expect(patch?.chartValues[0]).not.toBe(chartValues[0]);
    expect(patch?.chartLabels).not.toBe(chartLabels);
    expect(secondPatch?.chartValues).not.toBe(patch?.chartValues);
    expect(chartValues).toEqual([[10], [20]]);
    expect(chartLabels).toEqual([CURRENT_ROUND - 1]);
  });

  it('returns no patch when rows mismatch, preventing a label-only append', () => {
    const chartValues = [[10]];
    const chartLabels = [CURRENT_ROUND - 1];

    expect(appendRoundChartPoint(chartValues, chartLabels, resultPlayers(), CURRENT_ROUND, SERVER_CHART_CAP)).toBeNull();
    expect(chartValues).toEqual([[10]]);
    expect(chartLabels).toEqual([CURRENT_ROUND - 1]);
  });

  it('enforces a finite server cap and treats null as the local uncapped policy', () => {
    const players = resultPlayers();
    const cappedValues = [[10, 30], [20, 40]];
    const cappedLabels = [CURRENT_ROUND - 2, CURRENT_ROUND - 1];
    const overCappedLabels = [CURRENT_ROUND - 3, CURRENT_ROUND - 2, CURRENT_ROUND - 1];

    expect(appendRoundChartPoint(cappedValues, cappedLabels, players, CURRENT_ROUND, SERVER_CHART_CAP)).toBeNull();
    expect(appendRoundChartPoint(cappedValues, overCappedLabels, players, CURRENT_ROUND, SERVER_CHART_CAP)).toBeNull();
    expect(appendRoundChartPoint(cappedValues, cappedLabels, players, CURRENT_ROUND, LOCAL_UNCAPPED))
      .toEqual({ chartValues: [[10, 30, 900], [20, 40, 1200]], chartLabels: [CURRENT_ROUND - 2, CURRENT_ROUND - 1, CURRENT_ROUND] });
  });
});

describe('buildTurnResultPatch', () => {
  it('maps the shared turn result fields, clears liveTurnState, and appends bounded history and chart data', () => {
    const state = freezePatchState(patchState());
    const result = freezeNextTurnResult(nextTurnResult());

    const patch = buildTurnResultPatch(state, result, SERVER_CHART_CAP);
    const secondPatch = buildTurnResultPatch(state, result, SERVER_CHART_CAP);

    expect(patch).toMatchObject({
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
      historyLog: [state.historyLog[0], result.historyEntry],
      chartValues: [[10, 900], [20, 1200]],
      chartLabels: [CURRENT_ROUND - 1, CURRENT_ROUND],
    });
    expect(patch.historyLog).not.toBe(state.historyLog);
    expect(patch.chartValues).not.toBe(state.chartValues);
    expect(patch.chartLabels).not.toBe(state.chartLabels);
    expect(secondPatch.historyLog).not.toBe(patch.historyLog);
    expect(secondPatch.chartValues).not.toBe(patch.chartValues);
    expect(secondPatch.chartValues?.[0]).not.toBe(patch.chartValues?.[0]);
    expect(secondPatch.chartLabels).not.toBe(patch.chartLabels);
    expect(state.historyLog).toEqual([historyEntry('old-entry', CURRENT_ROUND - 1)]);
    expect(state.chartValues).toEqual([[10], [20]]);
    expect(state.chartLabels).toEqual([CURRENT_ROUND - 1]);
    expect(state.liveTurnState).toEqual({ turnScore: 300 });
    expect(result.historyEntry).toEqual(historyEntry('new-entry'));
    expect(result.players.map(player => player.score)).toEqual([900, 1200]);
  });

  it('caps history immutably and omits chart fields when no chart point is valid', () => {
    const fullHistory = Array.from({ length: MAX_HISTORY_LOG_SIZE }, (_, index) => historyEntry(`old-${index}`, index + 1));
    const state = patchState({ historyLog: fullHistory, chartValues: [[10]], chartLabels: [CURRENT_ROUND - 1] });

    const patch = buildTurnResultPatch(state, nextTurnResult(), SERVER_CHART_CAP);

    expect(patch.historyLog).toHaveLength(MAX_HISTORY_LOG_SIZE);
    expect(patch.historyLog[0].id).toBe('old-1');
    expect(patch.historyLog[MAX_HISTORY_LOG_SIZE - 1].id).toBe('new-entry');
    expect(patch).not.toHaveProperty('chartValues');
    expect(patch).not.toHaveProperty('chartLabels');
    expect(state.historyLog[0].id).toBe('old-0');
  });

  it('omits chart fields when the turn result did not end a round', () => {
    const state = patchState();
    const patch = buildTurnResultPatch(state, nextTurnResult({ isRoundEnd: false }), LOCAL_UNCAPPED);

    expect(patch.historyLog).toEqual([state.historyLog[0], historyEntry('new-entry')]);
    expect(patch).not.toHaveProperty('chartValues');
    expect(patch).not.toHaveProperty('chartLabels');
    expect(state.chartValues).toEqual([[10], [20]]);
    expect(state.chartLabels).toEqual([CURRENT_ROUND - 1]);
  });
});
