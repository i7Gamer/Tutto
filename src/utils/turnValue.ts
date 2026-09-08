import type { CardType, Ruleset } from '../types';
import { applyTuttoBonus, checkValidityAndScore, getMaxValidSelection, isBust } from './diceLogic';
import { fixedCardAward } from './coreGameEngine';
import { DIE_FACES, TOTAL_DICE } from './turnShapes';

/**
 * What a turn is worth from any point in it under best play — exact, for the
 * card on the table, with the bank in hand at every step. This is what
 * Optimal Otto keeps and rolls by (botStrategies.ts) and what the coach hint
 * shows a human (coachHint.ts).
 *
 * The old evaluation looked one roll ahead and assumed a bank straight after
 * it, keeping the most dice every time. That never saw a tutto's bonus, an
 * x2's doubling or the six fresh dice a tutto hands back, and it never asked
 * whether keeping FEWER dice — a lone 1 beside three 2s, rolling five instead
 * of two — is worth more. It is, early in a turn; late, with a big bank, it is
 * not (feature_plan_otto_full_info.md has the numbers). Only a value function
 * that runs to the end of the turn tells the two apart.
 *
 * Three objectives, one recursion:
 *  - points cards (a bonus card, x2, no card): the expected bank, Stop always
 *    on offer, a tutto ending the turn with its bonus applied;
 *  - Plus/Minus, Kleeblatt and Kniffel: the probability of FINISHING — the
 *    dice are worth nothing, only the tutto (or the straight) pays;
 *  - Feuerwerk: one roll deep still (slice 2 of the plan gives it its own).
 *
 * Every keep's validity and score comes from diceLogic's own helpers, so the
 * arithmetic here can never disagree with the table's; rolls are enumerated as
 * multisets with multinomial weights (923 for one to six dice, not 55 986
 * ordered outcomes), and every value is a sum of integer multiplicities times
 * a value, divided once by 6^n — exact whenever the true value is an integer.
 */

/** Dice by face: index 0 counts the 1s, index 5 the 6s. */
export type FaceCounts = readonly number[];

const ONES = 0;
const FIVES = 4;
/** Faces that only score three at a time. */
const TRIPLE_FACES: readonly number[] = [2, 3, 4, 6];
const TRIPLE = 3;

export const diceCounts = (vals: readonly number[]): number[] => {
  const counts = new Array<number>(DIE_FACES).fill(0);
  for (const v of vals) counts[v - 1]++;
  return counts;
};

/** The dice a count vector stands for, lowest face first. */
export const countsToVals = (counts: FaceCounts): number[] =>
  counts.flatMap((c, i) => Array<number>(c).fill(i + 1));

export const outcomeSpace = (dice: number): number => DIE_FACES ** dice;

const assertTable = (dice: number): void => {
  if (!Number.isInteger(dice) || dice < 1 || dice > TOTAL_DICE) {
    throw new RangeError(`turnValue: ${dice} dice is not a table`);
  }
};

/** One way of keeping dice off a table, with what it scores and what it leaves. */
export interface Keep {
  counts: number[];
  dice: number;
  score: number;
  /** The straight as this keep leaves it; [] on every other card. */
  progressAfter: number[];
}

/**
 * Every valid selection of a table. On a points card (and on Plus/Minus,
 * Kleeblatt and Feuerwerk, whose dice follow the same rules) that is any
 * number of the 1s, any number of the 5s and whole triples of the other
 * faces, never nothing. A Kniffel has exactly one: getMaxValidSelection's.
 * Modernized, the longer run (the two directions are symmetric when equal);
 * classic, one die per still-missing number — the dice on the table always
 * number the missing values, so declining one only rolls it again.
 */
export const legalKeeps = (
  counts: FaceCounts,
  card: CardType | null,
  progress: number[],
  ruleset: Ruleset,
): Keep[] => {
  if (card === 'Kniffel') {
    const vals = countsToVals(counts);
    const picked = getMaxValidSelection(vals, card, progress, ruleset).map(i => vals[i]);
    if (picked.length === 0) return [];
    const { score, newKniffelProgress } = checkValidityAndScore(picked, card, progress, ruleset);
    return [{ counts: diceCounts(picked), dice: picked.length, score, progressAfter: newKniffelProgress }];
  }

  const keeps: Keep[] = [];
  const keep = new Array<number>(DIE_FACES).fill(0);
  const emitSingles = () => {
    for (let ones = 0; ones <= counts[ONES]; ones++) {
      for (let fives = 0; fives <= counts[FIVES]; fives++) {
        keep[ONES] = ones;
        keep[FIVES] = fives;
        const vals = countsToVals(keep);
        if (vals.length === 0) continue;
        const { valid, score, newKniffelProgress } = checkValidityAndScore(vals, card, progress, ruleset);
        if (!valid) continue;
        keeps.push({ counts: [...keep], dice: vals.length, score, progressAfter: newKniffelProgress });
      }
    }
    keep[ONES] = 0;
    keep[FIVES] = 0;
  };
  const walkTriples = (i: number) => {
    if (i === TRIPLE_FACES.length) {
      emitSingles();
      return;
    }
    const index = TRIPLE_FACES[i] - 1;
    for (let taken = 0; taken <= counts[index]; taken += TRIPLE) {
      keep[index] = taken;
      walkTriples(i + 1);
    }
    keep[index] = 0;
  };
  walkTriples(0);
  return keeps;
};

export interface RollOutcome {
  counts: number[];
  /** How many of the 6^n ordered rolls show these counts. */
  multiplicity: number;
}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));

const outcomesByDice = new Map<number, RollOutcome[]>();

/** Every multiset `dice` dice can land as, with its multinomial multiplicity. */
export const rollOutcomes = (dice: number): RollOutcome[] => {
  assertTable(dice);
  const cached = outcomesByDice.get(dice);
  if (cached) return cached;
  const outcomes: RollOutcome[] = [];
  const counts = new Array<number>(DIE_FACES).fill(0);
  const walk = (face: number, left: number) => {
    if (face === DIE_FACES - 1) {
      counts[face] = left;
      let multiplicity = factorial(dice);
      for (const c of counts) multiplicity /= factorial(c);
      outcomes.push({ counts: [...counts], multiplicity });
      return;
    }
    for (let c = 0; c <= left; c++) {
      counts[face] = c;
      walk(face + 1, left - c);
    }
  };
  walk(0, dice);
  outcomesByDice.set(dice, outcomes);
  return outcomes;
};

export interface TableOutcome extends RollOutcome {
  bust: boolean;
  /** Empty exactly when the table busts. */
  keeps: Keep[];
  /** What getMaxValidSelection's keep scores here — the one-roll plan's number. */
  maxKeepScore: number;
}

// Only a Kniffel's odds move with what is already collected.
const progressKey = (card: CardType | null, progress: number[]): string =>
  card === 'Kniffel' ? progress.join(',') : '';

const tables = new Map<string, TableOutcome[]>();

/** The multisets of a roll, each judged by the card: bust or not, and every legal keep. */
export const tableOutcomes = (
  dice: number,
  card: CardType | null,
  progress: number[],
  ruleset: Ruleset,
): TableOutcome[] => {
  const key = `${dice}|${card}|${progressKey(card, progress)}|${ruleset}`;
  const cached = tables.get(key);
  if (cached) return cached;
  const table = rollOutcomes(dice).map(({ counts, multiplicity }) => {
    const vals = countsToVals(counts);
    const bust = isBust(vals, card, progress, ruleset);
    const keeps = bust ? [] : legalKeeps(counts, card, progress, ruleset);
    const maxKeepScore = bust ? 0
      : checkValidityAndScore(getMaxValidSelection(vals, card, progress, ruleset).map(i => vals[i]), card, progress, ruleset).score;
    return { counts, multiplicity, bust, keeps, maxKeepScore };
  });
  tables.set(key, table);
  return table;
};

const completionOdds = new Map<string, number>();

/**
 * The probability of reaching the tutto (or completing the straight) from
 * `dice` dice on the table, keeping at every roll whatever makes it likeliest.
 */
export const completionProbability = (
  dice: number,
  card: CardType | null,
  progress: number[],
  ruleset: Ruleset,
): number => {
  const key = `${dice}|${card}|${progressKey(card, progress)}|${ruleset}`;
  const cached = completionOdds.get(key);
  if (cached !== undefined) return cached;
  let sum = 0;
  for (const { multiplicity, bust, keeps } of tableOutcomes(dice, card, progress, ruleset)) {
    if (bust) continue;
    let best = 0;
    for (const keep of keeps) {
      const odds = keep.dice === dice ? 1 : completionProbability(dice - keep.dice, card, keep.progressAfter, ruleset);
      if (odds > best) best = odds;
    }
    sum += multiplicity * best;
  }
  const odds = sum / outcomeSpace(dice);
  completionOdds.set(key, odds);
  return odds;
};

/**
 * The bank is part of a points card's state, so this cache grows with every
 * distinct bank a game visits (multiples of 50, a few hundred per card) —
 * unlike the tables above, which are bounded by dice × cards × rulesets.
 */
export const TURN_VALUE_CACHE_MAX_ENTRIES = 20_000;

const rollOnValues = new Map<string, number>();

/**
 * Points cards only: what rolling `dice` dice with `bank` in hand is worth,
 * keeping whatever the rest of the turn is worth most with. A bust loses the
 * bank, a tutto ends the turn with the card's bonus applied, and anything in
 * between is held (holdValue) — banked or rolled on, whichever is worth more.
 */
export const rollOnValue = (bank: number, dice: number, card: CardType | null, ruleset: Ruleset): number => {
  const key = `${bank}|${dice}|${card}|${ruleset}`;
  const cached = rollOnValues.get(key);
  if (cached !== undefined) return cached;
  let sum = 0;
  for (const { multiplicity, bust, keeps } of tableOutcomes(dice, card, [], ruleset)) {
    if (bust) continue;
    let best = 0;
    for (const keep of keeps) {
      const bankAfter = bank + keep.score;
      const value = keep.dice === dice
        ? applyTuttoBonus(bankAfter, card)
        : holdValue(bankAfter, dice - keep.dice, card, ruleset);
      if (value > best) best = value;
    }
    sum += multiplicity * best;
  }
  const value = sum / outcomeSpace(dice);
  if (rollOnValues.size >= TURN_VALUE_CACHE_MAX_ENTRIES) rollOnValues.clear();
  rollOnValues.set(key, value);
  return value;
};

/** Holding `bank` with `dice` still to roll on a points card, where Stop is always on offer. */
export const holdValue = (bank: number, dice: number, card: CardType | null, ruleset: Ruleset): number =>
  Math.max(bank, rollOnValue(bank, dice, card, ruleset));

/**
 * The one-roll plan Otto used to price everything with: survive the next
 * roll, keep the most, bank. Kept for Feuerwerk until slice 2, and as the
 * floor every deeper value must clear (turnValue.test.ts).
 */
export const onePlyValue = (
  bank: number,
  dice: number,
  card: CardType | null,
  progress: number[],
  ruleset: Ruleset,
): number => {
  let sum = 0;
  for (const { multiplicity, bust, maxKeepScore } of tableOutcomes(dice, card, progress, ruleset)) {
    if (!bust) sum += multiplicity * (bank + maxKeepScore);
  }
  return sum / outcomeSpace(dice);
};

/** What the value of a table depends on beyond the dice: the card, the rules and the standings a Kleeblatt win is measured in. */
export interface ValueContext {
  card: CardType | null;
  ruleset: Ruleset;
  myScore: number;
  winningScore: number;
  tuttosThisTurn: number;
}

/**
 * What winning the game outright is worth to a player who needs
 * `winningScore - myScore` more points: at least that, at least the bank the
 * Kleeblatt is putting at stake, never negative. A heuristic — the one number
 * in this file that is not derived from the rules — and it only ever scales a
 * Kleeblatt's odds, so it never decides which dice to keep.
 */
export const kleeblattWinValue = (bank: number, myScore: number, winningScore: number): number =>
  Math.max(bank, winningScore - myScore, 0);

// A Kleeblatt needs two tuttos in a row: before the first, the second is still to come.
const secondTuttoOdds = (ctx: ValueContext): number =>
  ctx.tuttosThisTurn === 0 ? completionProbability(TOTAL_DICE, 'Kleeblatt', [], ctx.ruleset) : 1;

/**
 * What rolling `dice` dice with `bank` in hand is worth, in points, on this
 * card — the number Otto's roll-or-stop measures against the bank, and the
 * number every candidate keep is ranked by.
 */
export const continuationValue = (ctx: ValueContext, bank: number, dice: number, progress: number[]): number => {
  switch (ctx.card) {
    case 'Plus_Minus':
    case 'Kniffel':
      return completionProbability(dice, ctx.card, progress, ctx.ruleset) * (bank + fixedCardAward(ctx.card));
    case 'Kleeblatt':
      return completionProbability(dice, ctx.card, [], ctx.ruleset) * secondTuttoOdds(ctx)
        * kleeblattWinValue(bank, ctx.myScore, ctx.winningScore);
    case 'Feuerwerk':
      return onePlyValue(bank, dice, ctx.card, progress, ctx.ruleset);
    default:
      return rollOnValue(bank, dice, ctx.card, ctx.ruleset);
  }
};

/**
 * What a keep that completes the table is worth, given the bank AFTER the
 * tutto's bonus or the card's award (outcomeOfSelection's own number). The
 * turn ends there on every card but two: a first Kleeblatt tutto still has
 * the second to roll, and a Feuerwerk rolls six fresh dice whether it wants
 * to or not. A classic chain's draw is not priced yet (slice 3): the tutto
 * is worth its bank, which undervalues it by whatever drawing on adds.
 */
export const tuttoValue = (ctx: ValueContext, bankAfter: number): number => {
  switch (ctx.card) {
    case 'Kleeblatt':
      return secondTuttoOdds(ctx) * kleeblattWinValue(bankAfter, ctx.myScore, ctx.winningScore);
    case 'Feuerwerk':
      return continuationValue(ctx, bankAfter, TOTAL_DICE, []);
    default:
      return bankAfter;
  }
};

/** The order getMaxValidSelection lists a keep in: 1s, 5s, then the triples. */
const KEEP_FACE_ORDER: readonly number[] = [1, 5, 2, 3, 4, 6];

/** Which table positions a keep takes, each face in table order. */
export const keepIndices = (rollVals: readonly number[], keep: FaceCounts): number[] => {
  const indices: number[] = [];
  for (const face of KEEP_FACE_ORDER) {
    let wanted = keep[face - 1];
    for (let i = 0; i < rollVals.length && wanted > 0; i++) {
      if (rollVals[i] === face) {
        indices.push(i);
        wanted--;
      }
    }
  }
  return indices;
};
