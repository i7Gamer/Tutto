import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useReconnectResume, type UseReconnectResumeOptions } from './useReconnectResume';
import { localStore } from '../utils/storage';
import { buildTurnKey, DICE_TURN_STATE_KEY } from '../utils/diceTurnState';
import type { DiceSnapshot } from '../types';

const ROOM_ID = 'room-1';
const ROUND = 2;
const SEAT = 0;
const CARD = '300';
const RULESET = 'modernized';
const CURRENT_TURN_KEY = buildTurnKey(ROOM_ID, ROUND, SEAT, CARD, RULESET);

const snapshot = (over: Partial<DiceSnapshot> = {}): DiceSnapshot => ({
  turnScore: 300,
  keptDice: [],
  currentRoll: [],
  kniffelProgress: [],
  tuttosThisTurn: 0,
  ...over,
});

describe('useReconnectResume', () => {
  const base = (over: Partial<UseReconnectResumeOptions> = {}): UseReconnectResumeOptions => ({
    isOnline: true,
    justReconnected: true,
    isMyTurn: true,
    effectiveDiceMode: 'digital',
    liveTurnState: snapshot(),
    currentCard: CARD,
    currentPlayerName: 'Timo',
    currentPlayerIndex: SEAT,
    roomId: ROOM_ID,
    round: ROUND,
    ruleset: RULESET,
    addToast: vi.fn(),
    onResume: vi.fn(),
    ...over,
  });

  beforeEach(() => {
    localStore.remove(DICE_TURN_STATE_KEY);
    vi.clearAllMocks();
  });

  describe('online: the server relayed this seat\'s own snapshot back', () => {
    it('caches the snapshot under the current turn key, reopens the panel and says so', () => {
      const options = base();
      renderHook(() => useReconnectResume(options));

      const cached = JSON.parse(localStore.read(DICE_TURN_STATE_KEY) as string);
      expect(cached.turnKey).toBe(CURRENT_TURN_KEY);
      expect(cached.playerName).toBe('Timo');
      expect(cached.turnScore).toBe(300);
      expect(options.onResume).toHaveBeenCalledTimes(1);
      expect(options.addToast).toHaveBeenCalledWith('game.resumingDiceGame');
    });

    it('resumes at most once per reconnect episode, however often it re-runs', () => {
      const options = base();
      const { rerender } = renderHook(
        (props: UseReconnectResumeOptions) => useReconnectResume(props),
        { initialProps: options },
      );

      // What the resumed panel itself does ~300ms after mounting: push a new
      // live snapshot, which is a dependency of this effect.
      rerender({ ...options, liveTurnState: snapshot({ turnScore: 450 }) });

      expect(options.onResume).toHaveBeenCalledTimes(1);
      expect(options.addToast).toHaveBeenCalledTimes(1);
    });

    it('refuses a snapshot whose chain tail describes the card BEFORE the current one', () => {
      // The debounce means a mid-chain draw can land while the last pushed
      // snapshot still belongs to the card drawn from; re-stamping that one
      // would bank a chain the new card was never played for.
      const options = base({ liveTurnState: snapshot({ cardsThisTurn: ['Kniffel'] }) });
      renderHook(() => useReconnectResume(options));

      expect(localStore.read(DICE_TURN_STATE_KEY)).toBeNull();
      expect(options.onResume).not.toHaveBeenCalled();
    });

    it('accepts a snapshot whose chain tail IS the current card', () => {
      const options = base({ liveTurnState: snapshot({ cardsThisTurn: ['Kniffel', CARD] }) });
      renderHook(() => useReconnectResume(options));

      expect(options.onResume).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['it is somebody else\'s turn', { isMyTurn: false }],
      ['the seat plays with real dice', { effectiveDiceMode: 'physical' as const }],
      ['nothing was relayed', { liveTurnState: null }],
    ])('resumes nothing when %s', (_why, over) => {
      const options = base(over);
      renderHook(() => useReconnectResume(options));

      expect(localStore.read(DICE_TURN_STATE_KEY)).toBeNull();
      expect(options.onResume).not.toHaveBeenCalled();
      expect(options.addToast).not.toHaveBeenCalled();
    });

    it('re-arms once the reconnect episode is over, so the NEXT one resumes too', () => {
      const options = base();
      const { rerender } = renderHook(
        (props: UseReconnectResumeOptions) => useReconnectResume(props),
        { initialProps: options },
      );
      expect(options.onResume).toHaveBeenCalledTimes(1);

      // The store clears justReconnected on the next gameState event...
      rerender({ ...options, justReconnected: false });
      // ...and a second drop reconnects again.
      rerender({ ...options, justReconnected: true, liveTurnState: snapshot({ turnScore: 600 }) });

      expect(options.onResume).toHaveBeenCalledTimes(2);
    });
  });

  describe('offline: a cache entry survived the reload', () => {
    const offline = (over: Partial<UseReconnectResumeOptions> = {}) =>
      base({ isOnline: false, justReconnected: false, liveTurnState: null, roomId: null, ...over });

    const localTurnKey = buildTurnKey(null, ROUND, SEAT, CARD, RULESET);

    it('reopens the panel when the cached entry belongs to the turn on screen', () => {
      localStore.write(DICE_TURN_STATE_KEY, JSON.stringify(snapshot({ turnKey: localTurnKey })));
      const options = offline();

      renderHook(() => useReconnectResume(options));

      expect(options.onResume).toHaveBeenCalledTimes(1);
      expect(options.addToast).toHaveBeenCalledWith('game.resumingDiceGame');
      expect(localStore.read(DICE_TURN_STATE_KEY), 'the entry is kept for the panel to restore from').not.toBeNull();
    });

    it('discards a cached entry left over from a different turn', () => {
      localStore.write(DICE_TURN_STATE_KEY, JSON.stringify(snapshot({ turnKey: 'local:99:1:Kniffel:modernized' })));
      const options = offline();

      renderHook(() => useReconnectResume(options));

      expect(options.onResume).not.toHaveBeenCalled();
      expect(localStore.read(DICE_TURN_STATE_KEY)).toBeNull();
    });

    it('offers nothing when no entry survived — an empty cache is not a resume', () => {
      const options = offline();

      renderHook(() => useReconnectResume(options));

      expect(options.onResume).not.toHaveBeenCalled();
      expect(options.addToast).not.toHaveBeenCalled();
    });

    it('ignores an entry written after mount: only what survived the reload counts', () => {
      const options = offline();
      const { rerender } = renderHook(
        (props: UseReconnectResumeOptions) => useReconnectResume(props),
        { initialProps: options },
      );

      localStore.write(DICE_TURN_STATE_KEY, JSON.stringify(snapshot({ turnKey: localTurnKey })));
      rerender({ ...options, currentPlayerIndex: SEAT + 1 });

      expect(options.onResume).not.toHaveBeenCalled();
    });

    it('offers nothing to a seat playing with real dice', () => {
      localStore.write(DICE_TURN_STATE_KEY, JSON.stringify(snapshot({ turnKey: localTurnKey })));
      const options = offline({ effectiveDiceMode: 'physical' });

      renderHook(() => useReconnectResume(options));

      expect(options.onResume).not.toHaveBeenCalled();
    });
  });
});
