import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { usePhysicalChain, readPhysicalChainCache } from './usePhysicalChain';
import { PHYSICAL_TURN_STATE_KEY, buildTurnKey } from '../utils/diceTurnState';
import { MAX_CHAIN_CARDS } from '../types';
import { blockStorage, restoreStorage } from '../testing/storageStubs';

// The turn this suite plays in, and its cache key. Anything stamped with a
// different key belongs to a different turn.
const ROOM = 'R1';
const ROUND = 2;
const SEAT = 1;
const RULESET = 'classic';
const keyFor = (card) => buildTurnKey(ROOM, ROUND, SEAT, card, RULESET);

const defaultArgs = {
  enabled: true,
  roomId: ROOM,
  round: ROUND,
  currentPlayerIndex: SEAT,
  currentCard: '200',
  ruleset: RULESET,
  scoreInput: '',
};

const mount = (overrides = {}) =>
  renderHook(
    (props) => usePhysicalChain(props),
    { initialProps: { ...defaultArgs, ...overrides } },
  );

const readCache = () => JSON.parse(localStorage.getItem(PHYSICAL_TURN_STATE_KEY) ?? 'null');

const writeCache = (entry) =>
  localStorage.setItem(PHYSICAL_TURN_STATE_KEY, JSON.stringify(entry));

const validEntry = (overrides = {}) => ({
  turnKey: keyFor('200'),
  cards: [{ card: '200', completed: false }],
  plusMinusSuccesses: 0,
  awaitingChoice: false,
  scoreInput: '350',
  ...overrides,
});

describe('readPhysicalChainCache', () => {
  beforeEach(() => localStorage.clear());

  it('returns the entry stamped for exactly this turn', () => {
    writeCache(validEntry());
    expect(readPhysicalChainCache(keyFor('200'))).toEqual({
      turnKey: keyFor('200'),
      cards: [{ card: '200', completed: false }],
      plusMinusSuccesses: 0,
      awaitingChoice: false,
      scoreInput: '350',
    });
  });

  it('evicts an entry stamped for another turn rather than resuming into this one', () => {
    writeCache(validEntry({ turnKey: keyFor('300') }));
    expect(readPhysicalChainCache(keyFor('200'))).toBeNull();
    expect(localStorage.getItem(PHYSICAL_TURN_STATE_KEY)).toBeNull();
  });

  it.each([
    ['a non-object', '"nope"'],
    ['a missing turnKey', JSON.stringify({ cards: [{ card: '200', completed: false }], plusMinusSuccesses: 0, awaitingChoice: false })],
    ['unparseable JSON', '{not json'],
  ])('evicts %s', (_label, raw) => {
    localStorage.setItem(PHYSICAL_TURN_STATE_KEY, raw);
    expect(readPhysicalChainCache(keyFor('200'))).toBeNull();
    expect(localStorage.getItem(PHYSICAL_TURN_STATE_KEY)).toBeNull();
  });

  it.each([
    ['an empty card list', { cards: [] }],
    ['a malformed card entry', { cards: [{ card: 'NotACard', completed: false }] }],
    ['a card list past the chain cap', { cards: Array.from({ length: MAX_CHAIN_CARDS + 1 }, () => ({ card: '200', completed: true })) }],
    ['a non-integer counter', { plusMinusSuccesses: 1.5 }],
    ['a non-boolean choice flag', { awaitingChoice: 'yes' }],
  ])('evicts %s — the chain fields are load-bearing for undo', (_label, overrides) => {
    writeCache(validEntry(overrides));
    expect(readPhysicalChainCache(keyFor('200'))).toBeNull();
    expect(localStorage.getItem(PHYSICAL_TURN_STATE_KEY)).toBeNull();
  });

  it.each([
    ['not a string', 42],
    ['not digits', '12a'],
    ['longer than any real score', '12345678'],
  ])('keeps the chain and drops a score input that is %s — it is merely retypable', (_label, scoreInput) => {
    writeCache(validEntry({ scoreInput }));
    const restored = readPhysicalChainCache(keyFor('200'));
    expect(restored?.cards).toEqual([{ card: '200', completed: false }]);
    expect(restored?.scoreInput).toBe('');
  });
});

describe('usePhysicalChain', () => {
  beforeEach(() => localStorage.clear());

  describe('while disabled (not a classic physical turn)', () => {
    it('restores nothing and writes nothing', () => {
      writeCache(validEntry());
      const { result } = mount({ enabled: false, scoreInput: '900' });

      expect(result.current.hasChain()).toBe(false);
      expect(result.current.awaitingChoice).toBe(false);
      // The entry is left exactly as it was — untouched, not evicted.
      expect(readCache()).toEqual(validEntry());
    });
  });

  describe('restoring a turn in progress', () => {
    it('resumes the chain, the choice flag and the typed total', () => {
      writeCache(validEntry({
        cards: [{ card: '200', completed: true }, { card: 'Kniffel', completed: false }],
        plusMinusSuccesses: 1,
        awaitingChoice: true,
      }));
      const { result } = mount();

      expect(result.current.hasChain()).toBe(true);
      expect(result.current.awaitingChoice).toBe(true);
      expect(result.current.buildSummary('banked', true)).toEqual({
        cards: [{ card: '200', completed: true }, { card: 'Kniffel', completed: true }],
        tuttoCount: 2,
        plusMinusSuccesses: 1,
        ended: 'banked',
      });
    });

    it('starts fresh (and evicts) when the entry belongs to another turn', () => {
      writeCache(validEntry({ turnKey: keyFor('600') }));
      const { result } = mount();

      expect(result.current.hasChain()).toBe(false);
      expect(localStorage.getItem(PHYSICAL_TURN_STATE_KEY)).toBeNull();
    });
  });

  describe('recording what the turn did', () => {
    it('completeCurrentCard marks the card done, opens the choice and counts a Plus/Minus', () => {
      const { result } = mount({ currentCard: 'Plus_Minus' });

      act(() => result.current.completeCurrentCard(true));

      expect(result.current.awaitingChoice).toBe(true);
      expect(result.current.hasChain()).toBe(true);
      expect(result.current.buildSummary('banked', true)).toMatchObject({
        cards: [{ card: 'Plus_Minus', completed: true }],
        plusMinusSuccesses: 1,
      });
      expect(readCache()).toMatchObject({ turnKey: keyFor('Plus_Minus'), awaitingChoice: true });
    });

    it('does not count a Kniffel toward the Plus/Minus successes', () => {
      const { result } = mount({ currentCard: 'Kniffel' });
      act(() => result.current.completeCurrentCard(false));
      expect(result.current.buildSummary('banked', true).plusMinusSuccesses).toBe(0);
    });

    it('recordDraw appends the drawn card, closes the choice and stamps the POST-draw key', () => {
      const { result, rerender } = mount();

      act(() => result.current.completeCurrentCard(false));
      // How Game calls it: drawCardMidTurn puts the new card in the store and
      // recordDraw runs in the same handler, so the prop catches up in the
      // same commit. The entry must end up stamped for the card now showing.
      act(() => {
        result.current.recordDraw('Kniffel');
        rerender({ ...defaultArgs, currentCard: 'Kniffel' });
      });

      expect(result.current.awaitingChoice).toBe(false);
      expect(result.current.buildSummary('banked', false).cards).toEqual([
        { card: '200', completed: true },
        { card: 'Kniffel', completed: false },
      ]);
      expect(readCache().turnKey).toBe(keyFor('Kniffel'));
    });

    it('records a draw even before any chain action — the current card is the chain so far', () => {
      const { result } = mount();
      act(() => result.current.recordDraw('600'));
      expect(result.current.buildSummary('banked', false).cards).toEqual([
        { card: '200', completed: true },
        { card: '600', completed: false },
      ]);
    });
  });

  describe('the chain cap', () => {
    it('allows a draw while the chain is short of MAX_CHAIN_CARDS', () => {
      const { result } = mount();
      expect(result.current.canDrawAnotherCard()).toBe(true);
    });

    it('refuses once the chain has reached it — every validator rejects a longer one wholesale', () => {
      writeCache(validEntry({
        cards: Array.from({ length: MAX_CHAIN_CARDS }, () => ({ card: '200', completed: true })),
      }));
      const { result } = mount();
      expect(result.current.canDrawAnotherCard()).toBe(false);
    });
  });

  describe('buildSummary', () => {
    it('counts a completed Kleeblatt as two tuttos and an unresolved card as none', () => {
      writeCache(validEntry({
        cards: [{ card: '200', completed: true }, { card: 'Kleeblatt', completed: false }],
      }));
      const { result } = mount();

      expect(result.current.buildSummary('banked', true).tuttoCount).toBe(3);
      expect(result.current.buildSummary('null', false).tuttoCount).toBe(1);
    });

    it('carries a forfeited total for a turn that did not bank, and never for one that did', () => {
      const { result } = mount();
      expect(result.current.buildSummary('null', false, 700)).toMatchObject({ forfeitedScore: 700 });
      expect(result.current.buildSummary('stopCard', false, 700)).toMatchObject({ forfeitedScore: 700 });
      expect(result.current.buildSummary('banked', true, 700).forfeitedScore).toBeUndefined();
      expect(result.current.buildSummary('null', false, 0).forfeitedScore).toBeUndefined();
    });

    it('describes just the current card before any chain action', () => {
      const { result } = mount({ currentCard: '600' });
      expect(result.current.buildSummary('null', false)).toEqual({
        cards: [{ card: '600', completed: false }],
        tuttoCount: 0,
        plusMinusSuccesses: 0,
        ended: 'null',
      });
    });
  });

  describe('the cached entry follows the turn', () => {
    it('keeps up with what the player types, even with no chain action yet', () => {
      const { rerender } = mount();
      rerender({ ...defaultArgs, scoreInput: '450' });
      expect(readCache()).toMatchObject({ turnKey: keyFor('200'), scoreInput: '450' });
    });

    it('holds nothing when there is neither a chain nor a typed total', () => {
      // A total typed and then cleared (or committed) must not leave a
      // synthetic single-card entry behind.
      const { rerender } = mount({ scoreInput: '450' });
      expect(readCache()).not.toBeNull();

      rerender({ ...defaultArgs, scoreInput: '' });

      expect(localStorage.getItem(PHYSICAL_TURN_STATE_KEY)).toBeNull();
    });

    it('is dropped when the turn moves on, so it cannot leak into the next one', () => {
      const { result, rerender } = mount();
      act(() => result.current.completeCurrentCard(false));
      expect(readCache()).not.toBeNull();

      rerender({ ...defaultArgs, currentPlayerIndex: SEAT + 1, currentCard: '300' });

      expect(result.current.hasChain()).toBe(false);
      expect(result.current.awaitingChoice).toBe(false);
      expect(localStorage.getItem(PHYSICAL_TURN_STATE_KEY)).toBeNull();
    });

    it('survives a card change WITHIN the same turn — that is a chain draw, not a new turn', () => {
      const { result, rerender } = mount();
      act(() => result.current.completeCurrentCard(false));
      act(() => result.current.recordDraw('Kniffel'));

      rerender({ ...defaultArgs, currentCard: 'Kniffel' });

      expect(result.current.hasChain()).toBe(true);
      expect(readCache().cards).toHaveLength(2);
    });

    it('clearChain wipes the chain, the choice and the entry', () => {
      const { result } = mount();
      act(() => result.current.completeCurrentCard(true));

      act(() => result.current.clearChain());

      expect(result.current.hasChain()).toBe(false);
      expect(result.current.awaitingChoice).toBe(false);
      expect(localStorage.getItem(PHYSICAL_TURN_STATE_KEY)).toBeNull();
    });
  });

  describe('with storage refusing to cooperate', () => {
    afterEach(() => restoreStorage());

    it('still records the chain — losing persistence must not cost the turn', () => {
      blockStorage('localStorage');
      const { result } = mount();

      act(() => result.current.completeCurrentCard(true));

      expect(result.current.hasChain()).toBe(true);
      expect(result.current.awaitingChoice).toBe(true);
      expect(result.current.buildSummary('banked', true).plusMinusSuccesses).toBe(1);
    });
  });
});
