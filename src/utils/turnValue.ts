import type { CardType, InitialCards, Ruleset } from '../types';
import { applyTuttoBonus, checkValidityAndScore, getMaxValidSelection, isBust } from './diceLogic';
import { deckDrawOptions, fixedCardAward } from './coreGameEngine';
import { DIE_FACES, TOTAL_DICE } from './turnShapes';
import { RULESETS } from './configValidation';
import { BoundedValueCache, ChainValueCache } from './turnValueCache';

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
 *  - Feuerwerk: the expected total before the bust, since nothing is ever
 *    banked by choice there — a fixed point, because a tutto rolls six
 *    fresh dice and the six-dice gain is defined in terms of itself.
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
const DIE_FACE_VALUES: readonly number[] = Array.from({ length: DIE_FACES }, (_, i) => i + 1);
const FIRST_NON_EMPTY_SUBSET_MASK = 1;
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
 * faces, never nothing. A modernized Kniffel has exactly one:
 * getMaxValidSelection's; classic Kniffel offers every nonempty subset of
 * distinct missing faces. Modernized, the longer run (the two directions are
 * symmetric when equal); classic, every nonempty subset is considered because
 * keeping more distinct faces is not always optimal.
 */
export const legalKeeps = (
  counts: FaceCounts,
  card: CardType | null,
  progress: number[],
  ruleset: Ruleset,
): Keep[] => {
  if (card === 'Kniffel') {
    const vals = countsToVals(counts);
    if (ruleset === 'classic') {
      const collected = new Set(progress);
      const missing = DIE_FACE_VALUES.filter(face => counts[face - 1] > 0 && !collected.has(face));
      const keeps: Keep[] = [];
      for (let mask = FIRST_NON_EMPTY_SUBSET_MASK; mask < (1 << missing.length); mask++) {
        const picked = missing.filter((_, i) => (mask & (1 << i)) !== 0);
        const { valid, score, newKniffelProgress } = checkValidityAndScore(picked, card, progress, ruleset);
        if (valid) keeps.push({ counts: diceCounts(picked), dice: picked.length, score, progressAfter: newKniffelProgress });
      }
      return keeps;
    }
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

export const TABLE_CACHE_MAX_ENTRIES = 1024;
export const COMPLETION_CACHE_MAX_ENTRIES = 2000;
export const CHAIN_FREE_CACHE_MAX_ENTRIES = 10_000;
export const CHAIN_CACHE_MAX_BUCKETS = 4;
export const CHAIN_BUCKET_MAX_ENTRIES = 4000;
export const DRAW_CACHE_MAX_ENTRIES = 10_000;
// These two caches have exhaustive, validated key spaces and need no eviction.
export const ROLL_OUTCOME_CACHE_MAX_ENTRIES = TOTAL_DICE;
export const FEUERWERK_GAIN_CACHE_MAX_ENTRIES = RULESETS.length;

const tables = new BoundedValueCache<string, TableOutcome[]>(TABLE_CACHE_MAX_ENTRIES);

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

const completionOdds = new BoundedValueCache<string, number>(COMPLETION_CACHE_MAX_ENTRIES);

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

/** What a deck holds, by card — its composition only, never its order. */
export type DeckCounts = Partial<Record<CardType, number>>;

/** Public inputs from Game; the active chain is supplied by DiceGame itself. */
export interface DrawStrategyInputs {
  remainingCounts: DeckCounts;
  initialCards: InitialCards;
  completedReveals: readonly CardType[];
}

/**
 * The composition of the deck the next classic draw comes from: the cards
 * still in it, or a fresh deck's once it has run out (gameSlice rebuilds it
 * from initialCards on the draw that finds it empty). Composition is all a
 * fair player may know — the order would name the next card.
 */
export const remainingDeckCounts = (cards: readonly CardType[], initialCards: InitialCards): DeckCounts => {
  if (cards.length === 0) return { ...initialCards };
  const counts: DeckCounts = {};
  for (const card of cards) counts[card] = (counts[card] ?? 0) + 1;
  return counts;
};

/**
 * Relative weights of the next draw, using only counts and revealed cards.
 * The shuffle excludes a fourth repeat and sometimes forces a dominant
 * type. A rebuild starts a new run, including when it happened mid-chain:
 * the remaining deck's size tells us how many reveals belong to this deck.
 */
export const nextDrawWeights = (
  cards: readonly CardType[],
  initialCards: InitialCards,
  revealedCards: readonly CardType[],
): DeckCounts => nextDrawWeightsFromCounts(remainingDeckCounts(cards, initialCards), initialCards, revealedCards);

/** Composition-only variant used by live strategy consumers; never receives deck order. */
export const nextDrawWeightsFromCounts = (
  remainingCounts: DeckCounts,
  initialCards: InitialCards,
  revealedCards: readonly CardType[],
): DeckCounts => {
  const remainingSize = deckEntries(remainingCounts).reduce((sum, [, count]) => sum + count, 0);
  const remaining = new Map(deckEntries(remainingSize === 0 ? initialCards : remainingCounts));
  const initialSize = Object.values(initialCards).reduce((sum, count) => sum + (count ?? 0), 0);
  const drawnCount = remainingSize === 0 ? 0 : Math.max(0, initialSize - remainingSize);
  const firstReveal = Math.max(0, revealedCards.length - drawnCount);
  const lastCard = revealedCards.at(-1) ?? null;
  let runLength = 0;
  for (let i = revealedCards.length - 1; i >= firstReveal && revealedCards[i] === lastCard; i--) {
    runLength++;
  }
  const { candidates, forced } = deckDrawOptions(remaining, lastCard, runLength);
  return Object.fromEntries(forced ? [forced] : candidates);
};

/**
 * A classic chain's draw option: what the next card could be, and the
 * standings a Kleeblatt among them would be judged by. Absent under
 * modernized rules, where a completed card ends the turn.
 */
export interface ChainContext {
  /** Relative next-card weights from nextDrawWeights, after shuffle constraints. */
  deck: DeckCounts;
  myScore: number;
  winningScore: number;
}

const deckEntries = (deck: DeckCounts): [CardType, number][] =>
  (Object.entries(deck) as [CardType, number][]).filter(([, count]) => count > 0);

const chainKey = (chain: ChainContext | undefined): string => chain
  ? `${deckEntries(chain.deck).map(([card, count]) => `${card}:${count}`).sort().join(',')}|${chain.myScore}|${chain.winningScore}`
  : '';

/**
 * The bank is part of a points card's state, so these caches grow with
 * every distinct bank a game visits (multiples of 50, a few hundred per
 * card) and, in a classic chain, with every deck composition — unlike the
 * tables above. They live for the page, including across dice-panel unmounts.
 * Composition-only draw odds cannot expose deterministic replay order after
 * undo; restored contexts still use their full keys and can reuse a bucket.
 */
const chainFreeRollValues = new BoundedValueCache<string, number>(CHAIN_FREE_CACHE_MAX_ENTRIES);
const chainRollValues = new ChainValueCache(CHAIN_CACHE_MAX_BUCKETS, CHAIN_BUCKET_MAX_ENTRIES);

/**
 * Points cards only: what rolling `dice` dice with `bank` in hand is worth,
 * keeping whatever the rest of the turn is worth most with. A bust loses the
 * bank, a tutto ends the turn with the card's bonus applied — or, in a
 * classic chain, offers the draw (afterTutto) — and anything in between is
 * held (holdValue): banked or rolled on, whichever is worth more.
 */
export const rollOnValue = (
  bank: number,
  dice: number,
  card: CardType | null,
  ruleset: Ruleset,
  chain?: ChainContext,
): number => {
  const rollOnValues = chain ? chainRollValues.forChain(chainKey(chain)) : chainFreeRollValues;
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
        ? afterTutto(applyTuttoBonus(bankAfter, card), ruleset, chain)
        : holdValue(bankAfter, dice - keep.dice, card, ruleset, chain);
      if (value > best) best = value;
    }
    sum += multiplicity * best;
  }
  return rollOnValues.set(key, sum / outcomeSpace(dice));
};

/** Holding `bank` with `dice` still to roll on a points card, where Stop is always on offer. */
export const holdValue = (bank: number, dice: number, card: CardType | null, ruleset: Ruleset, chain?: ChainContext): number =>
  Math.max(bank, rollOnValue(bank, dice, card, ruleset, chain));

/** A completed card's bank, or the draw it offers in a classic chain, whichever is worth more. */
const afterTutto = (bank: number, ruleset: Ruleset, chain: ChainContext | undefined): number =>
  chain ? Math.max(bank, drawValue(chain, bank, ruleset)) : bank;

/**
 * The one-roll plan Otto used to price everything with: survive the next
 * roll, keep the most, bank. Kept as the floor every deeper value must
 * clear (turnValue.test.ts).
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

/**
 * The six-dice gain is a contraction of itself (some roll eventually busts,
 * and only a tutto's share of the outcomes refers back to it), so plain
 * iteration converges — about twenty rounds to this tolerance. The cap is
 * a guard against a loop, not a limit anyone expects to reach; past it the
 * last iterate is used rather than a throw inside a render.
 */
export const FEUERWERK_FIXED_POINT_EPSILON = 1e-9;
export const FEUERWERK_FIXED_POINT_MAX_ITERATIONS = 200;

// Classic Feuerwerk forces getMaxValidSelection's keep (diceTurnControls'
// withForcedFeuerwerkSelection): of the legal keeps, the one with every
// scoring die — the only one with the most dice.
const feuerwerkChoices = (keeps: Keep[], ruleset: Ruleset): Keep[] => {
  if (ruleset !== 'classic') return keeps;
  const most = Math.max(...keeps.map(k => k.dice));
  return keeps.filter(k => k.dice === most);
};

/** The gains from one to six dice, given a guess at what six fresh dice earn. */
const feuerwerkGainsGiven = (sixDice: number, ruleset: Ruleset): number[] => {
  const gains = new Array<number>(TOTAL_DICE + 1).fill(0);
  for (let dice = 1; dice <= TOTAL_DICE; dice++) {
    let sum = 0;
    for (const { multiplicity, bust, keeps } of tableOutcomes(dice, 'Feuerwerk', [], ruleset)) {
      if (bust) continue;
      let best = 0;
      for (const keep of feuerwerkChoices(keeps, ruleset)) {
        const worth = keep.score + (keep.dice === dice ? sixDice : gains[dice - keep.dice]);
        if (worth > best) best = worth;
      }
      sum += multiplicity * best;
    }
    gains[dice] = sum / outcomeSpace(dice);
  }
  return gains;
};

const feuerwerkGains = new Map<Ruleset, number[]>();

/**
 * What `dice` dice still earn on a Feuerwerk before the bust, on top of
 * whatever is in hand: no Stop is ever offered, a bust keeps everything
 * earned so far, and a tutto rolls six again with no bonus. Modernized, the
 * keep is free and the best one is taken; classic, it is forced.
 */
export const feuerwerkGain = (dice: number, ruleset: Ruleset): number => {
  let gains = feuerwerkGains.get(ruleset);
  if (!gains) {
    let sixDice = 0;
    gains = feuerwerkGainsGiven(sixDice, ruleset);
    for (let round = 0; round < FEUERWERK_FIXED_POINT_MAX_ITERATIONS
      && Math.abs(gains[TOTAL_DICE] - sixDice) > FEUERWERK_FIXED_POINT_EPSILON; round++) {
      sixDice = gains[TOTAL_DICE];
      gains = feuerwerkGainsGiven(sixDice, ruleset);
    }
    feuerwerkGains.set(ruleset, gains);
  }
  return gains[dice];
};

/**
 * What the value of a table depends on beyond the dice: the card, the rules,
 * the standings a Kleeblatt win is measured in, and — in a classic chain —
 * the deck the next draw comes from.
 */
export interface ValueContext {
  card: CardType | null;
  ruleset: Ruleset;
  myScore: number;
  winningScore: number;
  tuttosThisTurn: number;
  chain?: ChainContext;
}

/**
 * What winning the game outright is worth to a player who needs
 * `winningScore - myScore` more points: at least that, at least the bank the
 * Kleeblatt is putting at stake, never negative. A heuristic — the one number
 * in this file that is not derived from the rules. Used to compare a draw
 * against banking; bestKeep ranks Kleeblatt keeps by probability alone.
 */
export const kleeblattWinValue = (bank: number, myScore: number, winningScore: number): number =>
  Math.max(bank, winningScore - myScore, 0);

// A Kleeblatt needs two tuttos in a row: before the first, the second is still to come.
const secondTuttoOdds = (ctx: ValueContext): number =>
  ctx.tuttosThisTurn === 0 ? completionProbability(TOTAL_DICE, 'Kleeblatt', [], ctx.ruleset) : 1;

/**
 * What the card just drawn is worth with `bank` already on the line: six
 * fresh dice that must be rolled, priced one card deep (its own tutto banks).
 * A Stop forfeits the chain (drawNextCard), a Feuerwerk can only add (its
 * null banks everything), a Kleeblatt wins the game on two tuttos and loses
 * the chain otherwise, and the two fixed-award cards pay on their tutto.
 */
const drawnCardValue = (chain: ChainContext, card: CardType, bank: number, ruleset: Ruleset): number => {
  switch (card) {
    case 'Stop':
      return 0;
    case 'Feuerwerk':
      return bank + feuerwerkGain(TOTAL_DICE, ruleset);
    case 'Kleeblatt': {
      const tutto = completionProbability(TOTAL_DICE, card, [], ruleset);
      return tutto * tutto * kleeblattWinValue(bank, chain.myScore, chain.winningScore);
    }
    case 'Kniffel':
    case 'Plus_Minus':
      return completionProbability(TOTAL_DICE, card, [], ruleset) * (bank + fixedCardAward(card));
    default:
      return rollOnValue(bank, TOTAL_DICE, card, ruleset);
  }
};

const drawValues = new BoundedValueCache<string, number>(DRAW_CACHE_MAX_ENTRIES);

/** Read-only occupancy for deterministic bounds tests and local profiling. */
export const turnValueCacheSizes = () => ({
  chainFree: chainFreeRollValues.size,
  chainBuckets: chainRollValues.bucketCount,
  chainEntries: chainRollValues.bucketSizes,
  draw: drawValues.size,
  tables: tables.size,
  completion: completionOdds.size,
  outcomes: outcomesByDice.size,
  feuerwerk: feuerwerkGains.size,
});

/**
 * What drawing the next card is worth with `bank` at stake: every card the
 * deck can draw, weighted by nextDrawWeights' constrained distribution. When no card can come the draw
 * is refused and the bank stands (DiceGame's drawNextCard falls back to
 * banking), so that is what it is worth.
 */
export const drawValue = (chain: ChainContext, bank: number, ruleset: Ruleset): number => {
  const entries = deckEntries(chain.deck);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return bank;
  const key = `${bank}|${ruleset}|${chainKey(chain)}`;
  const cached = drawValues.get(key);
  if (cached !== undefined) return cached;
  const value = entries.reduce((sum, [card, count]) => sum + count * drawnCardValue(chain, card, bank, ruleset), 0) / total;
  return drawValues.set(key, value);
};

/**
 * What rolling `dice` dice with `bank` in hand is worth, in points, on this
 * card — the number Otto's roll-or-stop measures against the bank, and the
 * number every candidate keep is ranked by.
 */
export const continuationValue = (ctx: ValueContext, bank: number, dice: number, progress: number[]): number => {
  switch (ctx.card) {
    case 'Plus_Minus':
    case 'Kniffel':
      return completionProbability(dice, ctx.card, progress, ctx.ruleset)
        * afterTutto(bank + fixedCardAward(ctx.card), ctx.ruleset, ctx.chain);
    case 'Kleeblatt':
      return completionProbability(dice, ctx.card, [], ctx.ruleset) * secondTuttoOdds(ctx)
        * kleeblattWinValue(bank, ctx.myScore, ctx.winningScore);
    case 'Feuerwerk':
      return bank + feuerwerkGain(dice, ctx.ruleset);
    default:
      return rollOnValue(bank, dice, ctx.card, ctx.ruleset, ctx.chain);
  }
};

/**
 * What a keep that completes the table is worth, given the bank AFTER the
 * tutto's bonus or the card's award (outcomeOfSelection's own number). The
 * turn ends there — or, in a classic chain, the draw is on offer — on every
 * card but two: a first Kleeblatt tutto still has the second to roll (and a
 * completed one has won the game), and a Feuerwerk rolls six fresh dice
 * whether it wants to or not.
 */
export const tuttoValue = (ctx: ValueContext, bankAfter: number): number => {
  switch (ctx.card) {
    case 'Kleeblatt':
      return secondTuttoOdds(ctx) * kleeblattWinValue(bankAfter, ctx.myScore, ctx.winningScore);
    case 'Feuerwerk':
      return continuationValue(ctx, bankAfter, TOTAL_DICE, []);
    default:
      return afterTutto(bankAfter, ctx.ruleset, ctx.chain);
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
