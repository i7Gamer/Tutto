/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { applyOnlineGameAction } from './gameActionAuthority';
import { createRoom } from './rooms';
import { makeServerPlayer } from './socketTestHarness';
import type { TurnSummary } from '../src/types';

const host = 'host';
const actor = 'actor';
const turnScore = 500;
const opponentScore = 2000;
const activeRoom = () => {
  const room = createRoom(host);
  Object.assign(room.state, {
    status: 'playing', currentPlayerIndex: 1, currentCard: '300',
    players: [makeServerPlayer('Host', { socketId: host, score: opponentScore }),
      makeServerPlayer('Actor', { socketId: actor })],
  });
  room.dealtThisTurn = ['300'];
  return room;
};

describe('server-owned online actions', () => {
  it('rejects snapshots and unknown actions atomically', () => {
    const room = activeRoom();
    const before = structuredClone(room.state);
    expect(applyOnlineGameAction(room, undefined, actor)).toBe(false);
    expect(applyOnlineGameAction(room, { type: 'set-score', score: 999999 }, actor)).toBe(false);
    expect(room.state).toEqual(before);
  });

  it('derives a legal turn without assigning an opponent score', () => {
    const room = activeRoom();
    expect(applyOnlineGameAction(room, { type: 'commit', score: turnScore, success: true }, actor)).toBe(true);
    expect(room.state.players[0].score).toBe(opponentScore);
    expect(room.state.players[1].score).toBe(turnScore);
    expect(room.state.players[1].totalTurns).toBe(1);
    expect(room.state.currentPlayerIndex).toBe(0);
    expect(room.state.round).toBe(2);
  });

  it('does not let a non-acting host commit another player\'s turn', () => {
    const room = activeRoom();
    expect(applyOnlineGameAction(room, { type: 'commit', score: turnScore, success: true, players: [] }, host)).toBe(false);
    expect(room.state.players[0].score).toBe(opponentScore);
    expect(room.state.players[1].score).toBe(0);
  });

  it('starts/rematches with clean server-owned counters and undo data', () => {
    const room = activeRoom();
    room.state.finished = true;
    room.state.players[0].highestTurnScore = opponentScore;
    expect(applyOnlineGameAction(room, { type: 'start', score: 999999, finished: true }, host)).toBe(true);
    expect(room.state.finished).toBe(false);
    expect(room.state.players.every(p => p.score === 0 && p.totalTurns === 0)).toBe(true);
    expect(room.state.players[0].highestTurnScore).toBeUndefined();
    expect(room.state.round).toBe(1);
    expect(room.state.previousCard).toBeNull();
  });

  it('rejects out-of-turn, malformed and invalid phase actions', () => {
    const room = activeRoom();
    for (const value of [NaN, Infinity, -1, 0.5, '100']) {
      expect(applyOnlineGameAction(room, { type: 'commit', score: value, success: true }, actor)).toBe(false);
    }
    expect(applyOnlineGameAction(room, { type: 'commit', score: turnScore, success: true }, 'stranger')).toBe(false);
    expect(applyOnlineGameAction(room, { type: 'start' }, host)).toBe(false);
    expect(applyOnlineGameAction(room, { type: 'reset' }, actor)).toBe(false);
    expect(applyOnlineGameAction(room, { type: 'undo' }, host)).toBe(false);
  });

  it('undoes the server-owned prior turn and cannot repeat that undo', () => {
    const room = activeRoom();
    applyOnlineGameAction(room, { type: 'commit', score: turnScore, success: true }, actor);
    expect(applyOnlineGameAction(room, { type: 'undo' }, host)).toBe(true);
    expect(room.state.players[1].score).toBe(0);
    expect(room.state.players[1].totalTurns).toBe(0);
    expect(room.state.round).toBe(1);
    expect(applyOnlineGameAction(room, { type: 'undo' }, host)).toBe(false);
  });

  const classicTurn = () => {
    const room = activeRoom();
    room.state.ruleset = 'classic';
    room.state.currentCard = 'Plus_Minus';
    room.dealtThisTurn = ['Plus_Minus', 'Plus_Minus'];
    const summary: TurnSummary = {
      cards: [{ card: 'Plus_Minus', completed: true }, { card: 'Plus_Minus', completed: true }],
      ended: 'banked', tuttoCount: 2, plusMinusScores: [0, 1000],
      outcomes: [{ card: 'Plus_Minus', scoreBefore: 0, scoreAfter: 1000, tuttos: 1 },
        { card: 'Plus_Minus', scoreBefore: 1000, scoreAfter: 2000, tuttos: 1 }],
    };
    return { room, summary };
  };

  it('derives repeated classic deductions and reverses each occurrence on undo', () => {
    const { room, summary } = classicTurn();
    expect(applyOnlineGameAction(room, { type: 'commit', score: opponentScore, success: true, summary }, actor)).toBe(true);
    expect(room.state.players[0].score).toBe(0);
    expect(room.state.players[0].times1000PointsDeducted).toBe(2);
    expect(room.state.previousTurnSummary?.deductedPlayers).toEqual(['Host', 'Host']);
    expect(applyOnlineGameAction(room, { type: 'undo' }, host)).toBe(true);
    expect(room.state.players[0].score).toBe(opponentScore);
    expect(room.state.players[0].times1000PointsDeducted).toBe(0);
  });

  it.each(['tuttos', 'plus-minus', 'cards', 'score', 'prior-score'] as const)('rejects invented %s despite a plausible final total', field => {
    const { room, summary } = classicTurn();
    if (field === 'tuttos') summary.tuttoCount++;
    if (field === 'plus-minus') summary.plusMinusScores[1] = 0;
    if (field === 'cards') summary.cards.push({ card: '300', completed: true });
    if (field === 'score') summary.outcomes![1].scoreAfter++;
    if (field === 'prior-score') summary.outcomes![0].scoreBefore++;
    const before = structuredClone(room.state);
    expect(applyOnlineGameAction(room, { type: 'commit', score: opponentScore, success: true, summary }, actor)).toBe(false);
    expect(room.state).toEqual(before);
  });

  it('discards client-authored deduction and previous-record metadata', () => {
    const { room, summary } = classicTurn();
    summary.deductedPlayers = ['Actor'];
    summary.deductedAmounts = [9999];
    summary.prevMostCardsInTurn = 9999;
    expect(applyOnlineGameAction(room, { type: 'commit', score: opponentScore, success: true, summary }, actor)).toBe(true);
    expect(room.state.previousTurnSummary?.deductedPlayers).toEqual(['Host', 'Host']);
    expect(room.state.previousTurnSummary?.prevMostCardsInTurn).not.toBe(9999);
  });

  it('refuses a false successful Stop or failed special-card score', () => {
    const room = activeRoom();
    room.state.currentCard = 'Stop';
    expect(applyOnlineGameAction(room, { type: 'commit', score: turnScore, success: true }, actor)).toBe(false);
    room.state.currentCard = 'Plus_Minus';
    expect(applyOnlineGameAction(room, { type: 'commit', score: turnScore, success: false }, actor)).toBe(false);
  });

  it('does not accept a classic special-card success without its required completion', () => {
    for (const card of ['Kleeblatt', 'Kniffel', 'Plus_Minus'] as const) {
      const room = activeRoom();
      room.state.ruleset = 'classic';
      room.state.currentCard = card;
      room.dealtThisTurn = [card];
      const summary: TurnSummary = { cards: [{ card, completed: false }], tuttoCount: 0,
        plusMinusScores: [], ended: 'banked', outcomes: [{ card, scoreBefore: 0, scoreAfter: 0, tuttos: 0 }] };
      expect(applyOnlineGameAction(room, { type: 'commit', score: 0, success: true, summary }, actor)).toBe(false);
    }
  });
});
