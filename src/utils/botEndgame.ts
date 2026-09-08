import type { CardType, Ruleset } from '../types';
import { applyPlusMinusScores, fixedCardAward } from './coreGameEngine';
import { applyTuttoBonus, checkValidityAndScore } from './diceLogic';
import { canDrawAfterTutto } from './diceTurnControls';
import { TOTAL_DICE } from './turnShapes';
import type { DeckCounts } from './turnValue';

/** Present only when this seat closes the round and can settle the game. */
export interface EndgameStandings {
  opponentScores: readonly number[];
}

export interface EndgameTurn {
  myScore: number;
  winningScore: number;
  endgame?: EndgameStandings;
  currentCard: CardType | null;
  ruleset: Ruleset;
  turnScore: number;
  plusMinusScores?: readonly number[];
  deck: DeckCounts;
  canDraw?: boolean;
  chainCardCount?: number;
}

const ACTING_SEAT = 0;
const FIRST_CHAIN_CARD = 1;
const HIGHEST_SCORING_FACE = 1;
export type BankOutcome = 'win' | 'loss' | 'continue';

/** Pending deductions are resolved only in this hypothetical successful bank. */
export const bankOutcome = (ctx: EndgameTurn, bank: number): BankOutcome => {
  if (!ctx.endgame) return 'continue';
  let scores = [ctx.myScore, ...ctx.endgame.opponentScores];
  if (ctx.ruleset === 'classic') {
    for (const before of ctx.plusMinusScores ?? []) {
      scores = applyPlusMinusScores(scores, ACTING_SEAT, before, ctx.ruleset);
    }
  } else if (ctx.currentCard === 'Plus_Minus') {
    scores = applyPlusMinusScores(scores, ACTING_SEAT, ctx.turnScore, ctx.ruleset);
  }
  scores[ACTING_SEAT] += bank;
  const lead = Math.max(...scores);
  if (lead < ctx.winningScore || scores.filter(score => score === lead).length !== 1) return 'continue';
  return scores[ACTING_SEAT] === lead ? 'win' : 'loss';
};

/** Completing a classic Plus/Minus records its pre-award bank, without settling it. */
export const afterCardCompletion = (ctx: EndgameTurn, bankBefore: number): EndgameTurn =>
  ctx.ruleset === 'classic' && ctx.currentCard === 'Plus_Minus'
    ? { ...ctx, plusMinusScores: [...(ctx.plusMinusScores ?? []), bankBefore] }
    : ctx;

export const hasClassicDraw = (ctx: EndgameTurn): boolean => canDrawAfterTutto({
  isClassic: ctx.ruleset === 'classic', hasDrawCard: ctx.canDraw ?? true,
  isMakingTutto: true, canStop: true, currentCard: ctx.currentCard,
  chainCardCount: ctx.chainCardCount ?? FIRST_CHAIN_CARD,
});

/** Existential, one-card lookahead: a positive draw weight must allow avoiding defeat. */
export const canReachNonLosingDraw = (ctx: EndgameTurn, bank: number): boolean => {
  if (!ctx.endgame || !hasClassicDraw(ctx)) return false;
  return (Object.entries(ctx.deck) as [CardType, number][]).some(([card, weight]) =>
    weight > 0 && canReachNonLosingRoll({ ...ctx, currentCard: card, turnScore: bank, canDraw: false }, bank, TOTAL_DICE));
};

/** Best attainable successful settlement, not its likelihood or expected points. */
export const canReachNonLosingRoll = (ctx: EndgameTurn, bank: number, dice: number): boolean => {
  if (!ctx.endgame || ctx.currentCard === 'Stop') return false;
  // These can win outright or accumulate any finite total with positive probability.
  if (ctx.currentCard === 'Kleeblatt' || ctx.currentCard === 'Feuerwerk') return true;
  const award = fixedCardAward(ctx.currentCard);
  const gain = award || checkValidityAndScore(Array<number>(dice).fill(HIGHEST_SCORING_FACE), ctx.currentCard, [], ctx.ruleset).score;
  const bestBank = applyTuttoBonus(bank + gain, ctx.currentCard);
  const completed = afterCardCompletion(ctx, bank);
  return bankOutcome(completed, bestBank) !== 'loss' || canReachNonLosingDraw(completed, bestBank);
};
