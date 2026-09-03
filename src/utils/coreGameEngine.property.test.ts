/** @vitest-environment node */
/**
 * The oracle for B5 (calculateNextTurn / calculateUndo symmetry refactor).
 *
 * Plays a seeded, deterministic stream of turns across both rulesets and
 * asserts that undoing the turn calculateNextTurn just committed restores
 * the game to exactly the state it was in beforehand. This has to stay GREEN
 * before, during and after the extraction of applySummaryCounters /
 * revertSummaryCounters / applyClassicPlusMinus / advanceTurnOrder — any red
 * here means the split changed behaviour, not that the oracle is wrong.
 *
 * One carve-out is deliberate, not an oversight — see the comment beside the
 * bare-Stop branch below. (A second one, the undo of a never-set record
 * coming back as 0 instead of undefined, was a real asymmetry this oracle
 * documented for a while; it is fixed in calculateUndo and asserted exactly
 * again.)
 *
 * A third gap is structural rather than a carve-out: applySummaryCounters and
 * revertSummaryCounters both drive the same CARD_COUNTER_DELTAS table (delta
 * +1 / -1). A bug in that shared table — the wrong field for a card, say — is
 * applied identically in both directions, so apply-then-undo still round-trips
 * back to the exact starting state and this oracle sees nothing wrong. Only
 * the example-based suite, which asserts a counter's actual value after a
 * known card, would catch it.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateNextTurn,
  calculateUndo,
  buildDeck,
  PLUS_MINUS_SCORE,
  KNIFFEL_SCORE,
} from './coreGameEngine';
import { isSpecialCard } from './diceTurnControls';
import { makePlayer, makeGameState, nonNull } from '../testing/factories';
import type { CardType } from '../types';

// ── PRNG ─────────────────────────────────────────────────────────────────
// mulberry32: small, fast, deterministic. The seed is fixed so a failure is
// always reproducible from this file alone.
const PRNG_SEED = 0x5eed_c0de;

const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const makeRng = (seed: number) => {
  const rand = mulberry32(seed);
  return {
    next: () => rand(),
    nextInt: (n: number) => Math.floor(rand() * n),
    bool: (p = 0.5) => rand() < p,
  };
};

// ── Fixed test parameters (no magic numbers at the call sites below) ──────
const RULESETS = ['classic', 'modernized'] as const;
const GAMES_PER_RULESET = 4;
const TURNS_PER_GAME = 250; // 2 rulesets * 4 games * 250 turns = 2000 turns total
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const WINNING_SCORE = 1_000_000_000; // unreachable in a 250-turn game — keeps isGameOver false so undo is always in play
const DECK_BUFFER_THRESHOLD = 8; // top up before a turn could need more cards than remain
const PERFORMANCE_BUDGET_MS = 5000; // ~2s target with headroom for slower CI machines

const NUMERIC_CARDS = ['200', '300', '400', '500', '600'] as const;
const CONTINUABLE_CARDS = [...NUMERIC_CARDS, 'Kniffel', 'Plus_Minus', 'x2', 'Feuerwerk'] as const;
const CHAIN_CONTINUE_PROBABILITY = 0.35;
const CLASSIC_BANK_PROBABILITY = 0.5;
const MODERNIZED_NUMERIC_SUCCESS_PROBABILITY = 0.6;
const MODERNIZED_SPECIAL_SUCCESS_PROBABILITY = 0.5;
const NUMERIC_BONUS_MAX = 800;
const SPECIAL_VALUE_MIN = 100;
const SPECIAL_VALUE_RANGE = 2000;

const INITIAL_CARDS = {
  '200': 10, '300': 10, '400': 10, '500': 8, '600': 8,
  Kniffel: 6, Plus_Minus: 6, x2: 6, Feuerwerk: 6, Kleeblatt: 4, Stop: 6,
};

const numericValue = (card: string, rng: ReturnType<typeof makeRng>): number => {
  if (card === 'x2' || card === 'Feuerwerk') return SPECIAL_VALUE_MIN + rng.nextInt(SPECIAL_VALUE_RANGE);
  return Number(card) + rng.nextInt(NUMERIC_BONUS_MAX);
};

type PlayedCard = { card: CardType; completed: boolean };

// Adds one COMPLETED card's contribution to the running turn total, pushing
// a plusMinusScores entry (the total held *before* this card) for a
// completed Plus_Minus — mirrors what the classic chain replay in
// calculateNextTurn expects: one entry per successful Plus/Minus, in order.
const applyCompletedCardValue = (card: string, rng: ReturnType<typeof makeRng>, runningTotal: number, plusMinusScores: number[]): number => {
  if (card === 'Plus_Minus') {
    plusMinusScores.push(runningTotal);
    return runningTotal + PLUS_MINUS_SCORE;
  }
  if (card === 'Kniffel') return runningTotal + KNIFFEL_SCORE;
  return runningTotal + numericValue(card, rng);
};

// Resolves the LAST card of a chain: Stop and Kleeblatt always end it
// (Kleeblatt forced to fail — see the module comment on excluding a
// completed Kleeblatt, which wins the game instantly and is never undoable);
// anything else either banks (completes) or busts (fails) at random.
const resolveLastCard = (card: string, rng: ReturnType<typeof makeRng>, runningTotal: number, plusMinusScores: number[]) => {
  if (card === 'Stop') return { completed: false, ended: 'stopCard' as const, runningTotal };
  if (card === 'Kleeblatt') return { completed: false, ended: 'null' as const, runningTotal };
  if (!rng.bool(CLASSIC_BANK_PROBABILITY)) return { completed: false, ended: 'null' as const, runningTotal };
  return { completed: true, ended: 'banked' as const, runningTotal: applyCompletedCardValue(card, rng, runningTotal, plusMinusScores) };
};

const finishClassicTurn = (cards: PlayedCard[], runningTotal: number, ended: 'banked' | 'null' | 'stopCard', plusMinusScores: number[], cardsForState: CardType[]) => {
  const isSuccess = ended === 'banked';
  const tuttoCount = cards.filter(c => c.completed).length;
  const turnSummary = {
    cards, tuttoCount, plusMinusScores, ended,
    ...(isSuccess ? {} : { forfeitedScore: runningTotal }),
  };
  return { scoreInput: isSuccess ? runningTotal : 0, isSuccess, turnSummary, cardsForState };
};

// Builds one classic-ruleset turn. `cards` is the current deck (peeked, not
// mutated) — a 2-card chain's second card is the top of the deck, exactly as
// a real client would have already drawn it mid-chain before calling
// calculateNextTurn once at the end of the whole turn.
const generateClassicTurn = (rng: ReturnType<typeof makeRng>, currentCard: CardType, cards: CardType[]) => {
  if (currentCard === 'Stop') {
    // A bare Stop is identical under both rulesets: no dice, no chain,
    // nothing to summarize (see the bare-Stop handling in the turn loop).
    return { scoreInput: 0, isSuccess: false, turnSummary: undefined as undefined, cardsForState: cards };
  }

  const canContinue = (CONTINUABLE_CARDS as readonly string[]).includes(currentCard) && rng.bool(CHAIN_CONTINUE_PROBABILITY);
  const plusMinusScores: number[] = [];

  if (canContinue) {
    // c0 continues the chain, so it is completed by construction (a chain
    // never continues past a card that didn't complete).
    let runningTotal = applyCompletedCardValue(currentCard, rng, 0, plusMinusScores);
    const chain: PlayedCard[] = [{ card: currentCard, completed: true }];
    const c1 = cards[0];
    const last = resolveLastCard(c1, rng, runningTotal, plusMinusScores);
    chain.push({ card: c1, completed: last.completed });
    runningTotal = last.runningTotal;
    return finishClassicTurn(chain, runningTotal, last.ended, plusMinusScores, cards.slice(1));
  }

  const last = resolveLastCard(currentCard, rng, 0, plusMinusScores);
  const chain: PlayedCard[] = [{ card: currentCard, completed: last.completed }];
  return finishClassicTurn(chain, last.runningTotal, last.ended, plusMinusScores, cards);
};

// Builds one modernized-ruleset turn — no chaining, no turnSummary; a single
// card is resolved success/fail exactly the way the modernized branch of
// calculateNextTurn expects the caller to invoke it.
const generateModernizedTurn = (rng: ReturnType<typeof makeRng>, currentCard: CardType) => {
  if (currentCard === 'Stop') return { scoreInput: 0, isSuccess: false, turnSummary: undefined as undefined, cardsForState: undefined as undefined };
  if (currentCard === 'Kleeblatt') {
    // Excluded: a completed Kleeblatt wins instantly and calculateUndo
    // refuses a finished game — there is no undo contract to check there.
    return { scoreInput: 0, isSuccess: false, turnSummary: undefined as undefined, cardsForState: undefined as undefined };
  }
  if (isSpecialCard(currentCard)) {
    const isSuccess = rng.bool(MODERNIZED_SPECIAL_SUCCESS_PROBABILITY);
    return { scoreInput: 0, isSuccess, turnSummary: undefined as undefined, cardsForState: undefined as undefined };
  }
  const isSuccess = rng.bool(MODERNIZED_NUMERIC_SUCCESS_PROBABILITY);
  return { scoreInput: isSuccess ? numericValue(currentCard, rng) : 0, isSuccess, turnSummary: undefined as undefined, cardsForState: undefined as undefined };
};

// Independent re-derivation of the modernized wasBust/historyType mapping
// (coreGameEngine.ts ~440, ~485-493), used as a cross-check that the engine's
// classification of the turn we just generated matches what we intended —
// catches a generator bug as loudly as an engine bug.
const expectedModernizedOutcome = (currentCard: CardType, isSuccess: boolean) => {
  const wasBust = !isSuccess && !isSpecialCard(currentCard) && currentCard !== 'Stop';
  let historyType: string;
  if (currentCard === 'Stop') historyType = 'skip';
  else if (wasBust) historyType = 'bust';
  else if (isSpecialCard(currentCard)) historyType = isSuccess ? 'success' : 'fail';
  else historyType = 'success';
  return { wasBust, historyType };
};

interface RunTotals {
  turnsRun: number;
  turnsUndoVerified: number;
  turnsBareStopSkipped: number;
}

const runGame = (ruleset: 'classic' | 'modernized', rng: ReturnType<typeof makeRng>, numPlayers: number, totals: RunTotals) => {
  let players = Array.from({ length: numPlayers }, (_, i) => makePlayer({ name: `P${i + 1}` }));
  let cards = buildDeck(INITIAL_CARDS);
  let currentCard = nonNull(cards.shift());
  let currentPlayerIndex = 0;
  let round = 1;

  for (let turn = 0; turn < TURNS_PER_GAME; turn++) {
    if (cards.length < DECK_BUFFER_THRESHOLD) {
      // Top up well before the engine would ever see an empty deck (which
      // would trigger its own reshuffle-and-replace — a separately tested,
      // intentionally NOT byte-for-byte-undoable path; out of scope for B5).
      cards = [...cards, ...buildDeck(INITIAL_CARDS)];
    }

    const gen = ruleset === 'classic'
      ? generateClassicTurn(rng, currentCard, cards)
      : generateModernizedTurn(rng, currentCard);
    const cardsForCall = gen.cardsForState ?? cards;

    const beforePlayers = players;
    const beforeCards = cards;
    const beforeCurrentCard = currentCard;
    const beforeIndex = currentPlayerIndex;
    const beforeRound = round;

    const result = calculateNextTurn(
      makeGameState({
        players, currentPlayerIndex, currentCard, round,
        winningScore: WINNING_SCORE, cards: cardsForCall, initialCards: INITIAL_CARDS,
      }),
      gen.scoreInput, gen.isSuccess, gen.turnSummary,
    );

    // ── invariants ──────────────────────────────────────────────────────
    expect(result.isGameOver).toBe(false);
    expect(result.players[beforeIndex].totalTurns).toBe(beforePlayers[beforeIndex].totalTurns + 1);
    if (ruleset === 'classic') {
      for (const p of result.players) expect(p.score).toBeGreaterThanOrEqual(0);
      expect(result.previousWasBust).toBe(gen.turnSummary ? gen.turnSummary.ended === 'null' : false);
    } else {
      const expected = expectedModernizedOutcome(beforeCurrentCard, gen.isSuccess);
      expect(result.previousWasBust).toBe(expected.wasBust);
      expect(result.historyEntry.type).toBe(expected.historyType);
    }

    // ── the oracle: calculateUndo(calculateNextTurn(state)) === state ────
    const undone = calculateUndo({
      players: result.players,
      currentPlayerIndex: result.nextIndex,
      currentCard: result.drawnCard,
      round: result.nextRound,
      winningScore: WINNING_SCORE,
      cards: result.newDeck,
      initialCards: INITIAL_CARDS,
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
      finished: false,
      gameStartTime: null,
      gameTimeInSeconds: 0,
      historyLog: [],
    });

    if (beforeCurrentCard === 'Stop' && !gen.turnSummary) {
      // Documented at the top of calculateUndo: "A bare Stop turn commits
      // nothing ... and stays un-undoable." Nothing to verify a restore of.
      expect(undone).toBeNull();
      totals.turnsBareStopSkipped++;
    } else {
      expect(undone).not.toBeNull();
      const restored = undone!;
      expect(restored.nextIndex).toBe(beforeIndex);
      expect(restored.nextRound).toBe(beforeRound);
      expect(restored.drawnCard).toBe(beforeCurrentCard);
      expect(restored.newDeck).toEqual(beforeCards);
      expect(restored.players).toEqual(beforePlayers);
      totals.turnsUndoVerified++;
    }

    // Advance the real game forward regardless of this turn's undoability —
    // the property under test is "undo of the LAST turn", not "undo
    // everything", so the loop always keeps going on the forward result.
    players = result.players;
    currentPlayerIndex = result.nextIndex as number;
    round = result.nextRound;
    currentCard = nonNull(result.drawnCard);
    cards = result.newDeck;
    totals.turnsRun++;
  }
};

// buildDeck (called both by this file's deck top-ups and internally by
// calculateNextTurn/advanceTurnOrder on a reshuffle) draws from the real
// Math.random, not this file's seeded rng — left alone, that would make the
// exact turn sequence non-deterministic between runs even with PRNG_SEED
// fixed, defeating the point of seeding (a red run must be reproducible from
// this file alone). Pinned to its own mulberry32 stream for the test's
// duration and restored in `finally` so no other suite in the same process
// inherits a mocked Math.random.
const MATH_RANDOM_SEED = 0xdec0_5eed;

describe('coreGameEngine property test: calculateUndo(calculateNextTurn(state)) === state', () => {
  it(`restores every undoable turn across ${RULESETS.length * GAMES_PER_RULESET * TURNS_PER_GAME} generated turns (both rulesets, 2-4 players)`, () => {
    const rng = makeRng(PRNG_SEED);
    const totals: RunTotals = { turnsRun: 0, turnsUndoVerified: 0, turnsBareStopSkipped: 0 };
    const originalMathRandom = Math.random;
    Math.random = mulberry32(MATH_RANDOM_SEED);
    const start = performance.now();

    try {
      for (const ruleset of RULESETS) {
        for (let game = 0; game < GAMES_PER_RULESET; game++) {
          const numPlayers = MIN_PLAYERS + rng.nextInt(MAX_PLAYERS - MIN_PLAYERS + 1);
          runGame(ruleset, rng, numPlayers, totals);
        }
      }
    } finally {
      Math.random = originalMathRandom;
    }

    const durationMs = performance.now() - start;

    expect(totals.turnsRun).toBe(RULESETS.length * GAMES_PER_RULESET * TURNS_PER_GAME);
    // Sanity: both branches of the "undoable vs bare Stop" split actually fired.
    expect(totals.turnsUndoVerified).toBeGreaterThan(0);
    expect(totals.turnsBareStopSkipped).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(PERFORMANCE_BUDGET_MS);

    console.info(`[coreGameEngine.property.test] ${totals.turnsRun} turns, ${totals.turnsUndoVerified} undo-verified, ${totals.turnsBareStopSkipped} bare-Stop (un-undoable by design), ${durationMs.toFixed(1)}ms`);
  });
});
