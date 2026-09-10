import { calculateNextTurn, calculateUndo, noUndoableTurn, shuffleArray, KNIFFEL_SCORE, PLUS_MINUS_SCORE } from '../src/utils/coreGameEngine';
import { MAX_SCORE_MAGNITUDE, MIN_ONLINE_PLAYERS } from '../src/utils/configValidation';
import { PLAYER_RECORD_FIELDS, zeroedPlayerStats } from '../src/utils/playerStats';
import { isSpecialCard } from '../src/utils/diceTurnControls';
import { MAX_CHAIN_CARDS, MAX_HISTORY_LOG_SIZE, type TurnSummary } from '../src/types';
import { isValidTurnSummary, MAX_CHART_POINTS } from './pushValidation';
import type { Room, RoomState, ServerPlayer } from './roomTypes';

const FIRST_ROUND = 1;
const FIRST_SEAT = 0;
const KLEEBLATT_TUTTOS = 2;
const DOUBLE_SCORE = 2;
const boundedScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCORE_MAGNITUDE;

/** Manual/digital outcomes are claims; their legal effects and records are not. */
export const canonicalTurnSummary = (
  room: Room, value: unknown, score: number, success: boolean, timeout = false,
): TurnSummary | null => {
  if (!isValidTurnSummary(value)) return null;
  const reported = value;
  const outcomes = reported.outcomes;
  const dealt = room.dealtThisTurn;
  if (!outcomes || !Array.isArray(outcomes) || dealt.length === 0 || dealt.length > MAX_CHAIN_CARDS ||
      outcomes.length !== dealt.length || reported.cards.length !== dealt.length) return null;
  let runningScore = 0;
  let tuttoCount = 0;
  const plusMinusScores: number[] = [];
  for (let index = 0; index < dealt.length; index++) {
    const card = dealt[index];
    const entry = reported.cards[index];
    const outcome = outcomes[index];
    const last = index === dealt.length - 1;
    if (!outcome || outcome.card !== card || entry.card !== card ||
        !boundedScore(outcome.scoreBefore) || !boundedScore(outcome.scoreAfter) ||
        outcome.scoreBefore !== runningScore || outcome.scoreAfter < runningScore ||
        !Number.isInteger(outcome.tuttos) || outcome.tuttos < 0 || outcome.tuttos > MAX_CHAIN_CARDS) return null;
    if (!last && (!entry.completed || card === 'Stop' || card === 'Kleeblatt' || card === 'Feuerwerk')) return null;
    const expectedTuttos = card === 'Kleeblatt' ? KLEEBLATT_TUTTOS : 1;
    if (card === 'Stop') {
      if (entry.completed || outcome.tuttos !== 0 || outcome.scoreAfter !== runningScore) return null;
    } else if (card !== 'Feuerwerk') {
      if (entry.completed ? outcome.tuttos !== expectedTuttos :
        outcome.tuttos > (card === 'Kleeblatt' ? 1 : 0)) return null;
    }
    if (card === 'Plus_Minus' || card === 'Kniffel') {
      const award = card === 'Plus_Minus' ? PLUS_MINUS_SCORE : KNIFFEL_SCORE;
      if (outcome.scoreAfter !== runningScore + (entry.completed ? award : 0)) return null;
      if (card === 'Plus_Minus' && entry.completed) plusMinusScores.push(runningScore);
    } else if (entry.completed && card === 'x2') {
      if (outcome.scoreAfter < runningScore * DOUBLE_SCORE) return null;
    } else if (entry.completed && /^\d+$/.test(card)) {
      if (outcome.scoreAfter < runningScore + Number(card)) return null;
    }
    tuttoCount += outcome.tuttos;
    runningScore = outcome.scoreAfter;
  }
  const last = dealt[dealt.length - 1];
  if (success && isSpecialCard(last) && !reported.cards[reported.cards.length - 1].completed) return null;
  if (reported.tuttoCount !== tuttoCount || reported.plusMinusScores.length !== plusMinusScores.length ||
      reported.plusMinusScores.some((value, index) => value !== plusMinusScores[index])) return null;
  if (!timeout && (success !== (reported.ended === 'banked') || reported.ended === 'timeout')) return null;
  if (last === 'Stop' ? reported.ended !== 'stopCard' : reported.ended === 'stopCard') return null;
  if (success && last !== 'Kleeblatt' && score !== runningScore) return null;
  if (!success && score !== 0) return null;
  if (!success && (reported.forfeitedScore ?? 0) !== runningScore) return null;
  // Deliberately discard client-authored deduction/undo record metadata.
  return {
    cards: reported.cards.map(entry => ({ card: entry.card, completed: entry.completed })),
    tuttoCount, plusMinusScores, ended: reported.ended,
    ...(!success && runningScore > 0 ? { forfeitedScore: runningScore } : {}),
    outcomes: outcomes.map(entry => ({ card: entry.card, scoreBefore: entry.scoreBefore, scoreAfter: entry.scoreAfter, tuttos: entry.tuttos })),
  };
};

const cleanPlayers = (players: ServerPlayer[]): ServerPlayer[] => players.map(player => {
  const clean = { ...player, ...zeroedPlayerStats() };
  for (const field of PLAYER_RECORD_FIELDS) delete clean[field];
  return clean;
});

/** The wire snapshot never supplies gameplay state. Only a validated action does. */
export const applyOnlineGameAction = (room: Room, value: unknown, socketId: string): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  const before = room.state;
  const active = before.currentPlayerIndex === null ? undefined : before.players[before.currentPlayerIndex];
  const seated = before.players.some(player => player.socketId === socketId && !player.disconnected);
  const host = seated && room.host === socketId;
  if (!host && (!seated || active?.socketId !== socketId)) return false;

  if (action.type === 'start') {
    if (!host || (before.status === 'playing' && !before.finished) || before.players.length < MIN_ONLINE_PLAYERS) return false;
    const players = cleanPlayers(before.players);
    const ordered = before.randomOrder ? shuffleArray(players) : players;
    room.state = { ...before, players: ordered, status: 'playing', finished: false,
      round: FIRST_ROUND, currentPlayerIndex: FIRST_SEAT, currentCard: null, cards: [],
      gameTimeInSeconds: 0, liveTurnState: null, historyLog: [],
      chartNames: ordered.map(player => player.name), chartLabels: [], chartValues: ordered.map(() => []),
      ...noUndoableTurn() };
    return true;
  }
  if (action.type === 'reset') {
    if (!host) return false;
    room.state = { ...before, status: 'lobby', finished: false, currentPlayerIndex: null,
      currentCard: null, cards: [], round: FIRST_ROUND, gameTimeInSeconds: 0,
      liveTurnState: null, historyLog: [], chartNames: [], chartLabels: [], chartValues: [], ...noUndoableTurn() };
    return true;
  }
  if (before.status !== 'playing' || before.finished || before.currentPlayerIndex === null) return false;
  const calculationState = { ...before, gameStartTime: null };
  if (action.type === 'undo') {
    const result = calculateUndo(calculationState);
    if (!result) return false;
    room.state = { ...before, players: result.players as ServerPlayer[], currentPlayerIndex: result.nextIndex,
      round: result.nextRound, liveTurnState: null, ...noUndoableTurn(), historyLog: before.historyLog.slice(0, -1),
      ...(result.isRoundEndUndo ? { chartLabels: before.chartLabels.slice(0, -1),
        chartValues: before.chartValues.map(series => series.slice(0, -1)) } : {}) };
    return true;
  }
  if (action.type !== 'commit' || active?.socketId !== socketId || !boundedScore(action.score) || typeof action.success !== 'boolean') return false;
  if (before.currentCard === 'Stop' && (action.score !== 0 || action.success)) return false;
  if (isSpecialCard(before.currentCard) && !action.success && action.score !== 0) return false;
  let summary: TurnSummary | undefined;
  if (before.ruleset === 'classic') {
    if (before.currentCard === 'Stop' && room.dealtThisTurn.length === 1 && action.summary === undefined) {
      summary = { cards: [{ card: 'Stop', completed: false }], tuttoCount: 0, plusMinusScores: [], ended: 'stopCard' };
    } else {
      const canonical = canonicalTurnSummary(room, action.summary, action.score, action.success);
      if (!canonical) return false;
      summary = canonical;
    }
  } else if (action.summary !== undefined || !before.currentCard) return false;

  const result = calculateNextTurn({ ...calculationState, currentPlayerIndex: before.currentPlayerIndex }, action.score, action.success, summary, false, false);
  const next: RoomState = { ...before, players: result.players as ServerPlayer[],
    currentPlayerIndex: result.nextIndex, round: result.nextRound, finished: result.isGameOver, liveTurnState: null,
    previousCard: result.previousCard, previousScore: result.previousScore, previousLeaders: result.previousLeaders as ServerPlayer[] | null,
    previousWasBust: result.previousWasBust, previousWasSuccess: result.previousWasSuccess,
    previousHighestTurnScore: result.previousHighestTurnScore,
    previousHighestFeuerwerkTurnScore: result.previousHighestFeuerwerkTurnScore,
    previousHighestX2TurnScore: result.previousHighestX2TurnScore,
    previousPlayerName: result.previousPlayerName, previousTurnSummary: result.previousTurnSummary,
    historyLog: [...before.historyLog, result.historyEntry].slice(-MAX_HISTORY_LOG_SIZE),
  };
  if (result.isRoundEnd && before.chartValues.length === result.players.length && before.chartLabels.length < MAX_CHART_POINTS) {
    next.chartValues = before.chartValues.map((series, index) => [...series, result.players[index].score]);
    next.chartLabels = [...before.chartLabels, before.round];
  }
  // Deck advancement/restoration uses only the private server deal ledger in
  // settleDeck, after acceptance. Ignore the engine's optimistic draw result.
  room.state = next;
  return true;
};
