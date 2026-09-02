import { describe, it, expect } from 'vitest';
import type { CoreGameState, Player } from '../types';
import { makePlayer, makeGameState, mockFetchJson, nonNull } from './factories';

describe('makePlayer', () => {
  it('returns a full Player with every counter zeroed', () => {
    const player = makePlayer() satisfies Player;
    expect(player).toEqual({
      name: 'Player',
      score: 0,
      times1000PointsDeducted: 0,
      timesKniffelCompleted: 0,
      timesPlusMinusCompleted: 0,
      timesKniffelFailed: 0,
      timesKleeblattFailed: 0,
      timesKleeblattCompleted: 0,
      timesPlusMinusFailed: 0,
      timesFeuerwerkReceived: 0,
      timesSkipped: 0,
      timesx2Received: 0,
      totalTurns: 0,
      busts: 0,
      feuerwerkBusts: 0,
      x2Busts: 0,
      feuerwerkPointsScored: 0,
      x2PointsScored: 0,
      totalTuttos: 0,
      position: 0,
    });
  });

  it('applies overrides on top of the zeroed defaults', () => {
    const player = makePlayer({ name: 'Alice', score: 500, busts: 2 });
    expect(player.name).toBe('Alice');
    expect(player.score).toBe(500);
    expect(player.busts).toBe(2);
    // Untouched fields stay at their zeroed default.
    expect(player.totalTurns).toBe(0);
  });

  it('gives every call its own object — overriding one does not leak to another', () => {
    const alice = makePlayer({ name: 'Alice', score: 100 });
    const bob = makePlayer({ name: 'Bob' });
    expect(bob.score).toBe(0);
    expect(alice).not.toBe(bob);
  });
});

describe('makeGameState', () => {
  it('returns a full CoreGameState with a two-player default roster', () => {
    const state = makeGameState() satisfies CoreGameState;
    expect(state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.round).toBe(1);
    expect(state.finished).toBe(false);
    expect(state.historyLog).toEqual([]);
    expect(state.previousTurnSummary).toBeNull();
  });

  it('applies overrides on top of the default state', () => {
    const players = [makePlayer({ name: 'Zoe' })];
    const state = makeGameState({ players, round: 5, finished: true });
    expect(state.players).toBe(players);
    expect(state.round).toBe(5);
    expect(state.finished).toBe(true);
    // Untouched fields stay at their default.
    expect(state.winningScore).toBe(6000);
  });

  it('gives each call its own historyLog/cards arrays, not a shared reference', () => {
    const a = makeGameState();
    const b = makeGameState();
    expect(a.historyLog).not.toBe(b.historyLog);
    expect(a.cards).not.toBe(b.cards);
  });
});

describe('mockFetchJson', () => {
  it('builds a real Response with a 200 status by default', async () => {
    const res = mockFetchJson({ hello: 'world' });
    expect(res).toBeInstanceOf(Response);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hello: 'world' });
  });

  it('honors an explicit status and ok: false', async () => {
    const res = mockFetchJson({ error: 'nope' }, { ok: false, status: 404 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'nope' });
  });

  it('defaults to a 500 status when ok: false is passed without a status', () => {
    const res = mockFetchJson({}, { ok: false });
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
  });
});

describe('nonNull', () => {
  it('returns the value unchanged when present', () => {
    expect(nonNull('value')).toBe('value');
    expect(nonNull(0)).toBe(0);
  });

  it('throws when the value is null or undefined', () => {
    expect(() => nonNull(null)).toThrow('Expected a non-null value');
    expect(() => nonNull(undefined)).toThrow('Expected a non-null value');
  });

  it('throws with a custom message when provided', () => {
    expect(() => nonNull(null, 'stats row missing')).toThrow('stats row missing');
  });
});
