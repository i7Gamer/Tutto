/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { afterCardCompletion, bankOutcome, canReachNonLosingRoll, canReachNonLosingDraw, type EndgameTurn } from './botEndgame';
import { MAX_CHAIN_CARDS, type TurnSummary } from '../types';
import { calculateNextTurn } from './coreGameEngine';
import { makeGameState, makePlayer } from '../testing/factories';

const turn = (overrides: Partial<EndgameTurn> = {}): EndgameTurn => ({
  myScore: 4900, winningScore: 6000, endgame: { opponentScores: [6100] },
  currentCard: '200', ruleset: 'modernized', turnScore: 0, deck: {}, ...overrides,
});

describe('endgame settlement and bounded reachability', () => {
  it('distinguishes winning, losing, tied, below-target and unknown settlements', () => {
    expect(bankOutcome(turn(), 1100)).toBe('loss');
    expect(bankOutcome(turn(), 1200)).toBe('continue');
    expect(bankOutcome(turn(), 1250)).toBe('win');
    expect(bankOutcome(turn({ endgame: undefined }), 1250)).toBe('continue');
    expect(bankOutcome(turn({ endgame: { opponentScores: [] } }), 1250)).toBe('win');
    expect(bankOutcome(turn({ endgame: { opponentScores: [5000] } }), 100)).toBe('continue');
    expect(bankOutcome(turn({ endgame: { opponentScores: [6100, 6100] } }), 0)).toBe('continue');
  });

  it('replays pending classic deductions at their own pre-card scores', () => {
    const input = turn({ ruleset: 'classic', myScore: 4500, endgame: { opponentScores: [6500, 6200] },
      plusMinusScores: [0, 1000] });
    expect(bankOutcome(input, 2000)).toBe('win');
    expect(input.endgame?.opponentScores).toEqual([6500, 6200]);
    expect(bankOutcome({ ...input, plusMinusScores: [] }, 2000)).toBe('continue');
  });

  it('requires a non-losing reachable settlement, not just positive points', () => {
    expect(canReachNonLosingRoll(turn(), 1100, 1)).toBe(true);
    expect(canReachNonLosingRoll(turn({ endgame: { opponentScores: [10000] } }), 1100, 1)).toBe(false);
    expect(canReachNonLosingRoll(turn({ currentCard: 'Plus_Minus', endgame: { opponentScores: [8000] } }), 0, 1)).toBe(false);
    expect(canReachNonLosingRoll(turn({ currentCard: 'Kniffel' }), 0, 1)).toBe(true);
  });

  it('handles special cards and constrained classic draws within one card', () => {
    const classic = turn({ ruleset: 'classic', deck: { Kniffel: 1 }, canDraw: true });
    expect(canReachNonLosingDraw(classic, 0)).toBe(true);
    expect(canReachNonLosingDraw({ ...classic, deck: { Stop: 1, Kniffel: 0 } }, 1100)).toBe(false);
    expect(canReachNonLosingDraw({ ...classic, deck: {} }, 1100)).toBe(false);
    expect(canReachNonLosingDraw({ ...classic, canDraw: false }, 0)).toBe(false);
    expect(canReachNonLosingDraw({ ...classic, chainCardCount: MAX_CHAIN_CARDS }, 0)).toBe(false);
    expect(canReachNonLosingDraw(turn({ deck: { Kniffel: 1 } }), 0)).toBe(false);
    expect(canReachNonLosingRoll(turn({ currentCard: 'Kleeblatt' }), 0, 1)).toBe(true);
    expect(canReachNonLosingRoll(turn({ currentCard: 'Feuerwerk' }), 0, 1)).toBe(true);
    expect(canReachNonLosingRoll(turn({ currentCard: 'Stop' }), 0, 6)).toBe(false);
  });

  it('can reach the next card after completing this one, but does not look past that card', () => {
    const input = turn({ myScore: 0, ruleset: 'classic', deck: { Kniffel: 1 },
      endgame: { opponentScores: [6000] } });
    expect(canReachNonLosingRoll(input, 4000, 1)).toBe(true);
    expect(canReachNonLosingRoll({ ...input, canDraw: false }, 4000, 1)).toBe(false);
    expect(canReachNonLosingDraw(input, 2000)).toBe(false);
  });

  it('carries a completed Plus/Minus into the next ordinary card without applying it early', () => {
    const input = turn({ ruleset: 'classic', currentCard: 'Plus_Minus', myScore: 3500,
      endgame: { opponentScores: [6100] }, deck: { '200': 1 } });
    const completed = afterCardCompletion(input, 0);
    expect(completed.plusMinusScores).toEqual([0]);
    expect(completed.endgame?.opponentScores).toEqual([6100]);
    expect(bankOutcome(completed, 1000)).toBe('continue');
    expect(canReachNonLosingDraw(completed, 1000)).toBe(true);
    expect(canReachNonLosingDraw({ ...completed, deck: { Stop: 1 } }, 1000)).toBe(false);
  });

  it('agrees with engine settlement, including classic deduction order and modernized ties', () => {
    const cases: { ctx: EndgameTurn; bank: number }[] = [
      { ctx: turn(), bank: 1100 },
      { ctx: turn(), bank: 1200 },
      { ctx: turn(), bank: 1250 },
      { ctx: turn({ currentCard: 'Plus_Minus', myScore: 5000 }), bank: 1000 },
      { ctx: turn({ currentCard: 'Plus_Minus', myScore: 6100 }), bank: 1000 },
      { ctx: turn({ ruleset: 'classic', myScore: 4500, endgame: { opponentScores: [6500, 6200] },
        plusMinusScores: [0, 1000] }), bank: 2000 },
      { ctx: turn({ ruleset: 'classic', myScore: 0, endgame: { opponentScores: [400, 400] },
        plusMinusScores: [0] }), bank: 1000 },
      { ctx: turn({ ruleset: 'classic', currentCard: 'Plus_Minus', myScore: 5100,
        plusMinusScores: [0] }), bank: 1000 },
    ];
    for (const { ctx, bank } of cases) {
      const players = [...(ctx.endgame?.opponentScores ?? []).map((score, i) => makePlayer({ name: `opponent-${i}`, score })),
        makePlayer({ name: 'Otto', score: ctx.myScore })];
      const pending = ctx.plusMinusScores ?? [];
      const summary: TurnSummary | undefined = ctx.ruleset === 'classic' ? {
        cards: [...pending.map(() => ({ card: 'Plus_Minus' as const, completed: true })), { card: '200', completed: false }],
        plusMinusScores: [...pending], tuttoCount: pending.length, ended: 'banked',
      } : undefined;
      const state = makeGameState({ players, currentPlayerIndex: players.length - 1,
        currentCard: ctx.currentCard, winningScore: ctx.winningScore, cards: ['200'] });
      const result = calculateNextTurn(state, bank, true, summary);
      const acting = result.players.at(-1)!;
      const expected = !result.isGameOver ? 'continue'
        : acting.score === Math.max(...result.players.map(p => p.score)) ? 'win' : 'loss';
      expect(bankOutcome(ctx, bank)).toBe(expected);
    }
  });
});
