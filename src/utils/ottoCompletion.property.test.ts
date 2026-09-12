/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import type { Ruleset } from '../types';
import { coachHint } from './coachHint';
import { completionProbability, countsToVals, rollOutcomes } from './turnValue';
import { DIE_FACES, TOTAL_DICE } from './turnShapes';

type Objective = 'plusMinus' | 'classicStraight' | 'modernStraight';
const OBJECTIVES: readonly Objective[] = ['plusMinus', 'classicStraight', 'modernStraight'];
const FACES = Array.from({ length: DIE_FACES }, (_, index) => index + 1);
const TRIPLE_SIZE = 3;
const SINGLE_FACES = new Set([1, 5]);
const PROBABILITY_PRECISION = 10;
const WINNING_SCORE = 6000;
const FIRST_SUBSET = 1;
const COMPLETE = 1;

// Independent of legalKeeps/checkValidityAndScore: enumerate physical subsets
// and apply the card's rules directly, including shorter modernized runs.
const candidateSizes = (roll: number[], progress: number[], objective: Objective): number[] => {
  const sizes = new Set<number>();
  for (let mask = FIRST_SUBSET; mask < (1 << roll.length); mask++) {
    const picked = roll.filter((_, index) => mask & (1 << index));
    const unique = new Set(picked);
    let valid: boolean;
    if (objective === 'plusMinus') {
      valid = [...unique].every(face => SINGLE_FACES.has(face)
        || picked.filter(value => value === face).length % TRIPLE_SIZE === 0);
    } else if (objective === 'classicStraight') {
      valid = unique.size === picked.length && picked.every(face => !progress.includes(face));
    } else {
      const directions = progress.length === 0 ? [1, -1] : [progress[0] === 1 ? 1 : -1];
      valid = directions.some(direction => {
        const start = progress.length ? progress[progress.length - 1] + direction : direction === 1 ? 1 : DIE_FACES;
        return unique.size === picked.length
          && picked.every((_, index) => unique.has(start + index * direction));
      });
    }
    if (valid) sizes.add(picked.length);
  }
  return [...sizes];
};

// Enumerate ordered rolls (no multinomial weights), reducing only by the
// number of dice left. Straight faces are symmetric after choosing a direction.
const oracleProbabilities = (objective: Objective): number[] => {
  const probabilities = [COMPLETE];
  for (let dice = 1; dice <= TOTAL_DICE; dice++) {
    const progress = FACES.slice(0, TOTAL_DICE - dice);
    let sum = 0;
    const outcomes = DIE_FACES ** dice;
    for (let encoded = 0; encoded < outcomes; encoded++) {
      let remainder = encoded;
      const roll = Array.from({ length: dice }, () => {
        const face = remainder % DIE_FACES + 1;
        remainder = Math.floor(remainder / DIE_FACES);
        return face;
      });
      const sizes = candidateSizes(roll, progress, objective);
      sum += Math.max(0, ...sizes.map(size => probabilities[dice - size]));
    }
    probabilities.push(sum / outcomes);
  }
  return probabilities;
};

describe('Otto completion choices against independent ordered-roll probabilities', () => {
  it.each(OBJECTIVES)('maximizes %s completion for every roll and reachable straight progress', objective => {
    const probabilities = oracleProbabilities(objective);
    const currentCard = objective === 'plusMinus' ? 'Plus_Minus' : 'Kniffel';
    const rulesets: Ruleset[] = objective === 'plusMinus' ? ['classic', 'modernized']
      : [objective === 'classicStraight' ? 'classic' : 'modernized'];
    const progresses = objective === 'classicStraight'
      ? Array.from({ length: 1 << DIE_FACES }, (_, mask) => FACES.filter((_, index) => mask & (1 << index)))
        .filter(progress => progress.length < TOTAL_DICE)
      : Array.from({ length: TOTAL_DICE }, (_, kept) => FACES.slice(0, kept));
    if (objective === 'modernStraight') {
      progresses.push(...progresses.filter(progress => progress.length > 0)
        .map(progress => progress.map(face => DIE_FACES + 1 - face)));
    }

    for (const ruleset of rulesets) for (const progress of progresses) {
      const dice = TOTAL_DICE - progress.length;
      const kniffelProgress = currentCard === 'Kniffel' ? progress : [];
      expect(completionProbability(dice, currentCard, kniffelProgress, ruleset))
        .toBeCloseTo(probabilities[dice], PROBABILITY_PRECISION);
      for (const outcome of rollOutcomes(dice)) {
        const rollVals = countsToVals(outcome.counts);
        const sizes = candidateSizes(rollVals, progress, objective);
        const hint = coachHint({
          rollVals, keptCount: progress.length, turnScore: 0, currentCard, ruleset,
          kniffelProgress, standings: { myScore: 0, leaderScore: 0, winningScore: WINNING_SCORE },
          deck: {}, canDraw: false, chainCardCount: 0, tuttosThisTurn: 0,
          selectedIndices: rollVals.map((_, index) => index), isSelectionLocked: false,
        });
        const diagnostic = JSON.stringify({ objective, ruleset, progress, rollVals });
        if (sizes.length === 0) {
          expect(hint, diagnostic).toBeNull();
          continue;
        }
        expect(hint, diagnostic).not.toBeNull();
        const selected = hint!.keep;
        expect(candidateSizes(selected, progress, objective), diagnostic).toContain(selected.length);
        expect(probabilities[dice - selected.length], diagnostic)
          .toBeCloseTo(Math.max(...sizes.map(size => probabilities[dice - size])), PROBABILITY_PRECISION);
        expect(hint!.action, diagnostic).toBe(selected.length === dice ? 'stop' : 'roll');
        expect(hint!.selectionDiffers, diagnostic).toBe(selected.length !== rollVals.length);
      }
    }
  });
});
