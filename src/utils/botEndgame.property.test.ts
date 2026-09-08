/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { bankOutcome, type BankOutcome, type EndgameTurn } from './botEndgame';
import { calculateNextTurn, KNIFFEL_SCORE, PLUS_MINUS_SCORE } from './coreGameEngine';
import { makeGameState, makePlayer } from '../testing/factories';
import { applyTuttoBonus } from './diceLogic';
import type { CardType, TurnSummary } from '../types';

const CASES = 4000;
const SEED = 12345;
const RNG_MULTIPLIER = 1664525;
const RNG_INCREMENT = 1013904223;
const RNG_RANGE = 2 ** 32;
const SCORE_STEP = 500;
const SCORE_LEVELS = 15;
const TARGET = 6000;
const MAX_OPPONENTS = 3;
const MAX_PENDING_DEDUCTIONS = 2;
const CARDS: CardType[] = ['200', '500', 'x2', 'Plus_Minus', 'Kniffel'];
// Complete legal tables: six 2s, three 2s + three 3s, three 1s + three 2s.
const COMPLETE_TABLE_SCORES = [400, 500, 1200];

/** Independent rules oracle: never calls production deduction or outcome helpers. */
const settleScores = (ctx: EndgameTurn, bank: number): number[] => {
  const opponents = [...ctx.endgame!.opponentScores];
  const deductions = ctx.ruleset === 'classic' ? ctx.plusMinusScores ?? []
    : ctx.currentCard === 'Plus_Minus' ? [0] : [];
  for (const before of deductions) {
    const actingLead = ctx.myScore + (ctx.ruleset === 'classic' ? before : 0);
    const lead = Math.max(actingLead, ...opponents);
    if (ctx.ruleset === 'modernized' && actingLead === lead) continue;
    for (let index = 0; index < opponents.length; index++) {
      if (opponents[index] !== lead) continue;
      const deducted = opponents[index] - PLUS_MINUS_SCORE;
      opponents[index] = ctx.ruleset === 'classic' ? Math.max(0, deducted) : deducted;
    }
  }
  return [...opponents, ctx.myScore + bank];
};

const outcome = (scores: number[], target: number): BankOutcome => {
  const highest = Math.max(...scores);
  if (highest < target || scores.filter(score => score === highest).length !== 1) return 'continue';
  return scores.at(-1) === highest ? 'win' : 'loss';
};

describe('independent seeded endgame settlement', () => {
  it('agrees with engine scores and winner over 4000 valid settlements', () => {
    let seed = SEED;
    const random = (range: number): number => {
      seed = (seed * RNG_MULTIPLIER + RNG_INCREMENT) % RNG_RANGE;
      return Math.floor(seed / RNG_RANGE * range);
    };
    const observed = new Set<BankOutcome>();
    for (let index = 0; index < CASES; index++) {
      const classic = index % 2 === 0;
      const card = CARDS[random(CARDS.length)];
      const pendingCount = classic ? random(MAX_PENDING_DEDUCTIONS + 1) : 0;
      // Every successful Plus/Minus adds 1000; later pre-card banks cannot go backwards.
      const pending: number[] = [];
      let bank = 0;
      for (let deduction = 0; deduction < pendingCount; deduction++) {
        pending.push(bank);
        bank += PLUS_MINUS_SCORE;
      }
      if (classic && card === 'Plus_Minus') pending.push(bank);
      bank = card === 'Plus_Minus' ? bank + PLUS_MINUS_SCORE
        : card === 'Kniffel' ? bank + KNIFFEL_SCORE
          : applyTuttoBonus(bank + COMPLETE_TABLE_SCORES[random(COMPLETE_TABLE_SCORES.length)], card);
      const ctx: EndgameTurn = {
        ruleset: classic ? 'classic' : 'modernized', currentCard: card,
        myScore: random(SCORE_LEVELS) * SCORE_STEP, winningScore: TARGET,
        endgame: { opponentScores: Array.from({ length: 1 + random(MAX_OPPONENTS) }, () => random(SCORE_LEVELS) * SCORE_STEP) },
        turnScore: 0, plusMinusScores: pending, deck: {},
      };
      const summary: TurnSummary | undefined = classic ? {
        cards: [...Array.from({ length: pendingCount }, () => ({ card: 'Plus_Minus' as const, completed: true })),
          { card, completed: true }],
        plusMinusScores: pending, tuttoCount: pendingCount + 1, ended: 'banked',
      } : undefined;
      const scores = settleScores(ctx, bank);
      const expected = outcome(scores, TARGET);
      observed.add(expected);
      const players = [...ctx.endgame!.opponentScores, ctx.myScore]
        .map((score, player) => makePlayer({ name: `player-${player}`, score }));
      const state = makeGameState({ players, currentPlayerIndex: players.length - 1,
        currentCard: card, winningScore: TARGET, cards: ['200' as const] });
      const result = calculateNextTurn(state, bank, true, summary);
      const fixture = JSON.stringify({ index, ctx, bank });
      expect(result.players.map(player => player.score), fixture).toEqual(scores);
      expect(result.isGameOver, fixture).toBe(expected !== 'continue');
      expect(bankOutcome(ctx, bank), fixture).toBe(expected);
    }
    expect(observed).toEqual(new Set(['continue', 'win', 'loss']));
  });
});
