/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { MAX_PLAYER_NAME_LENGTH, MAX_SCORE_MAGNITUDE } from '../src/utils/configValidation';
import { MAX_CHAIN_CARDS, type DiceSnapshot, type TurnSummary } from '../src/types';
import { TOTAL_DICE } from '../src/utils/turnShapes';
import { isValidDiceSnapshot, isValidTurnSummary, sanitizeDiceSnapshot } from './turnPayloadValidation';

const SAMPLE_SCORE = 100;
const SAMPLE_FORFEITED_SCORE = 500;
const SAMPLE_DEDUCTION = 400;
const OVER_TOTAL_DICE = TOTAL_DICE + 1;
const OVER_CHAIN_CARDS = MAX_CHAIN_CARDS + 1;

const validSnapshot: DiceSnapshot = {
  turnScore: SAMPLE_SCORE,
  tuttosThisTurn: 0,
  keptDice: [{ id: 'd1', val: 4 }],
  currentRoll: [{ id: 'd2', val: 3, selected: false }],
  kniffelProgress: [1, 2],
};

const validSummary: TurnSummary = {
  cards: [{ card: '300', completed: true }],
  tuttoCount: 1,
  plusMinusScores: [],
  ended: 'banked',
};

describe('isValidDiceSnapshot', () => {
  it('accepts and sanitizes known dice snapshot fields', () => {
    const withExtras: DiceSnapshot & { junk: string } = {
      ...validSnapshot,
      keptDice: validSnapshot.keptDice.map(die => ({ ...die, junk: 'drop' })),
      currentRoll: validSnapshot.currentRoll.map(die => ({ ...die, junk: 'drop' })),
      busted: true,
      stopped: true,
      rollingDiceIds: ['d1', 'd2'],
      cardsThisTurn: ['300', 'Feuerwerk'],
      plusMinusScores: [SAMPLE_SCORE],
      chainTuttoCount: 1,
      lastCardCompleted: true,
      cardOutcomes: [Object.assign(
        { card: '300' as const, scoreBefore: 0, scoreAfter: SAMPLE_SCORE, tuttos: 1 },
        { junk: 'drop' },
      )],
      junk: 'drop me',
    };

    expect(isValidDiceSnapshot(withExtras)).toBe(true);
    const clean = sanitizeDiceSnapshot(withExtras);
    expect(clean).toMatchObject({
      turnScore: SAMPLE_SCORE,
      busted: true,
      stopped: true,
      rollingDiceIds: ['d1', 'd2'],
      cardsThisTurn: ['300', 'Feuerwerk'],
      plusMinusScores: [SAMPLE_SCORE],
      chainTuttoCount: 1,
      lastCardCompleted: true,
    });
    expect(clean.keptDice).toEqual([{ id: 'd1', val: 4 }]);
    expect(clean.currentRoll).toEqual([{ id: 'd2', val: 3, selected: false }]);
    expect(clean.cardOutcomes).toEqual([{ card: '300', scoreBefore: 0, scoreAfter: SAMPLE_SCORE, tuttos: 1 }]);
    expect(clean.keptDice).not.toBe(withExtras.keptDice);
    expect(clean.currentRoll).not.toBe(withExtras.currentRoll);
    expect(clean.kniffelProgress).not.toBe(withExtras.kniffelProgress);
    expect(clean.rollingDiceIds).not.toBe(withExtras.rollingDiceIds);
    expect(clean.cardsThisTurn).not.toBe(withExtras.cardsThisTurn);
    expect(clean.plusMinusScores).not.toBe(withExtras.plusMinusScores);
    expect(clean.cardOutcomes).not.toBe(withExtras.cardOutcomes);
    expect(clean.cardOutcomes?.[0]).not.toBe(withExtras.cardOutcomes?.[0]);
    expect('junk' in clean).toBe(false);
  });

  it('rejects non-object, non-finite, and over-limit required fields', () => {
    expect(isValidDiceSnapshot(null)).toBe(false);
    expect(isValidDiceSnapshot('snapshot')).toBe(false);
    expect(isValidDiceSnapshot({})).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, turnScore: NaN })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, turnScore: Infinity })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, tuttosThisTurn: Infinity })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, keptDice: Array(OVER_TOTAL_DICE).fill({ id: 'd1', val: 1 }) })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, currentRoll: Array(OVER_TOTAL_DICE).fill({ id: 'd1', val: 1, selected: false }) })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, kniffelProgress: Array(OVER_TOTAL_DICE).fill(1) })).toBe(false);
  });
  it('rejects malformed dice and unbounded numeric fields', () => {
    expect(isValidDiceSnapshot({ ...validSnapshot, turnScore: MAX_SCORE_MAGNITUDE + 1 })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, turnScore: -1 })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, tuttosThisTurn: -1 })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, keptDice: [{ id: 'd1', val: '4' }] })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, currentRoll: [{ id: 'd2', val: 3 }] })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, kniffelProgress: [0] })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, busted: 'yes' })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, rollingDiceIds: Array(OVER_TOTAL_DICE).fill('d1') })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, cardsThisTurn: Array(OVER_CHAIN_CARDS).fill('300') })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, plusMinusScores: [MAX_SCORE_MAGNITUDE + 1] })).toBe(false);
    expect(isValidDiceSnapshot({ ...validSnapshot, cardOutcomes: [{ card: 'Nope' }] })).toBe(false);
  });
});

describe('isValidTurnSummary', () => {
  it('accepts bounded classic summaries including optional restore metadata', () => {
    expect(isValidTurnSummary({
      ...validSummary,
      ended: 'timeout',
      forfeitedScore: MAX_SCORE_MAGNITUDE,
      prevMostCardsInTurn: null,
      prevHighestForfeitedTurnScore: SAMPLE_FORFEITED_SCORE,
      deductedPlayers: ['Bob'],
      deductedAmounts: [SAMPLE_DEDUCTION],
      outcomes: [{ card: '300', scoreBefore: 0, scoreAfter: SAMPLE_SCORE, tuttos: 1 }],
    })).toBe(true);
  });

  it('rejects malformed or unbounded summary fields', () => {
    expect(isValidTurnSummary({ ...validSummary, ended: 'later' })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, cards: [{ card: 'Nope', completed: true }] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, tuttoCount: -1 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, plusMinusScores: [MAX_SCORE_MAGNITUDE + 1] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, forfeitedScore: MAX_SCORE_MAGNITUDE + 1 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: [''] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['Bob'], deductedAmounts: [SAMPLE_DEDUCTION, SAMPLE_DEDUCTION] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['Bob'], deductedAmounts: ['400'] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, outcomes: [{ card: 'Nope' }] })).toBe(false);
  });

  it('enforces network bounds on optional records and deduction amounts', () => {
    expect(isValidTurnSummary({ ...validSummary, prevMostCardsInTurn: MAX_SCORE_MAGNITUDE })).toBe(true);
    expect(isValidTurnSummary({ ...validSummary, prevMostCardsInTurn: MAX_SCORE_MAGNITUDE + 1 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, prevHighestForfeitedTurnScore: MAX_SCORE_MAGNITUDE + 1 })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['Bob'], deductedAmounts: [-1] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['Bob'], deductedAmounts: [NaN] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['Bob'], deductedAmounts: [MAX_SCORE_MAGNITUDE + 1] })).toBe(false);
    expect(isValidTurnSummary({ ...validSummary, deductedPlayers: ['x'.repeat(MAX_PLAYER_NAME_LENGTH + 1)], deductedAmounts: [0] })).toBe(false);
  });
});
