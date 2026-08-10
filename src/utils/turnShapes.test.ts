import { describe, it, expect } from 'vitest';
import {
  MAX_DICE_ID_LENGTH, isSnapshotDie, isRolledDie, isKniffelProgressEntry,
  isChainCard, isChainCounter, isTurnCardPlayed, isTurnEnd, isTurnCardList,
} from './turnShapes';
import { MAX_CHAIN_CARDS, TURN_ENDS } from '../types';
import { VALID_CARD_TYPES } from './configValidation';

const die = (over: Record<string, unknown> = {}) => ({ id: 'd1', val: 3, ...over });

describe('isSnapshotDie', () => {
  it('accepts a plain die', () => {
    expect(isSnapshotDie(die())).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6])('accepts the face %i', (val) => {
    expect(isSnapshotDie(die({ val }))).toBe(true);
  });

  it.each([0, 7, -1, 1.5, NaN, Infinity, '3', null])('rejects the face %p', (val) => {
    expect(isSnapshotDie(die({ val }))).toBe(false);
  });

  it.each([null, undefined, 42, 'die', []])('rejects the non-object %p', (v) => {
    expect(isSnapshotDie(v)).toBe(false);
  });

  it('rejects a missing or empty id', () => {
    expect(isSnapshotDie({ val: 3 })).toBe(false);
    expect(isSnapshotDie(die({ id: '' }))).toBe(false);
    expect(isSnapshotDie(die({ id: 7 }))).toBe(false);
  });

  it('bounds the id length — a uuid fits with room to spare', () => {
    expect(isSnapshotDie(die({ id: 'x'.repeat(MAX_DICE_ID_LENGTH) }))).toBe(true);
    expect(isSnapshotDie(die({ id: 'x'.repeat(MAX_DICE_ID_LENGTH + 1) }))).toBe(false);
    expect(MAX_DICE_ID_LENGTH).toBeGreaterThanOrEqual(36); // uuidv4
  });
});

describe('isRolledDie', () => {
  it('needs the selected flag on top of a snapshot die', () => {
    expect(isRolledDie(die({ selected: false }))).toBe(true);
    expect(isRolledDie(die({ selected: true }))).toBe(true);
    expect(isRolledDie(die())).toBe(false);
    expect(isRolledDie(die({ selected: 'yes' }))).toBe(false);
  });
});

describe('isKniffelProgressEntry', () => {
  it.each([1, 6])('accepts %i', (v) => expect(isKniffelProgressEntry(v)).toBe(true));
  it.each([0, 7, 2.5, '3', null, NaN])('rejects %p', (v) => expect(isKniffelProgressEntry(v)).toBe(false));
});

describe('isChainCard', () => {
  it.each(VALID_CARD_TYPES)('accepts %s', (card) => expect(isChainCard(card)).toBe(true));
  it.each(['Joker', '', 'stop', 700, null, {}])('rejects %p', (v) => expect(isChainCard(v)).toBe(false));
});

describe('isChainCounter', () => {
  it.each([0, 1, MAX_CHAIN_CARDS])('accepts %i', (v) => expect(isChainCounter(v)).toBe(true));
  it.each([-1, MAX_CHAIN_CARDS + 1, 1.5, '2', null, NaN, Infinity])('rejects %p', (v) => {
    expect(isChainCounter(v)).toBe(false);
  });
});

describe('isTurnCardPlayed', () => {
  it('accepts a card with its completion flag', () => {
    expect(isTurnCardPlayed({ card: 'Kniffel', completed: true })).toBe(true);
    expect(isTurnCardPlayed({ card: '200', completed: false })).toBe(true);
  });

  it.each([
    { card: 'Kniffel' },
    { completed: true },
    { card: 'Joker', completed: true },
    { card: 'Kniffel', completed: 'yes' },
    null,
    'Kniffel',
  ])('rejects %p', (v) => expect(isTurnCardPlayed(v)).toBe(false));
});

describe('isTurnEnd', () => {
  // Derived from the same list the TurnEnd type is, so a new kind cannot be
  // added to the type without this recognising it.
  it.each(TURN_ENDS)('accepts %s', (v) => expect(isTurnEnd(v)).toBe(true));
  it.each(['aborted', '', 'BANKED', null, 0])('rejects %p', (v) => expect(isTurnEnd(v)).toBe(false));
});

describe('isTurnCardList', () => {
  const card = { card: 'x2' as const, completed: true };

  it('accepts a list within the chain cap', () => {
    expect(isTurnCardList([card])).toBe(true);
    expect(isTurnCardList(Array(MAX_CHAIN_CARDS).fill(card))).toBe(true);
  });

  it('accepts an empty list — a summary may legitimately carry none', () => {
    expect(isTurnCardList([])).toBe(true);
  });

  it('rejects a list past the chain cap', () => {
    expect(isTurnCardList(Array(MAX_CHAIN_CARDS + 1).fill(card))).toBe(false);
  });

  it('rejects a non-array, and any list with one bad entry', () => {
    expect(isTurnCardList('x2')).toBe(false);
    expect(isTurnCardList([card, { card: 'Joker', completed: true }])).toBe(false);
  });
});
