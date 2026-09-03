/**
 * The persistence SUBSCRIBERS, as opposed to pickLocalGameState's read-back
 * (persistence.test.ts). Split into its own file because these need a DOM:
 * localStorage is what they write to, and that suite runs in the node
 * environment deliberately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { attachPersistence, LOCAL_GAME_SCHEMA_VERSION } from './persistence';
import type { GameStore } from './useGameStore';
import { makeGameState, makePlayer } from '../testing/factories';

describe('attachPersistence', () => {
  // A fake store rather than the real one: this is about the subscriber's own
  // logic — when it writes and when it deliberately does not — and driving it
  // through the real store would mix in every action's own behaviour.
  const makeStore = () => {
    // A LIST, not a single handler: attachPersistence registers two
    // subscribers (the local game save and the online config save) and a fake
    // that keeps only the last one silently tests the wrong half.
    // Two params, matching zustand's real StoreApi['subscribe'] listener
    // signature (state, prevState) — attachPersistence only ever reads the
    // first, but the fake has to accept both to structurally satisfy the
    // Pick<StoreApi<GameStore>, 'subscribe'> parameter type.
    const listeners: Array<(s: GameStore, prev: GameStore) => void> = [];
    return {
      store: {
        subscribe: (fn: (s: GameStore, prev: GameStore) => void) => {
          listeners.push(fn);
          return () => { listeners.splice(listeners.indexOf(fn), 1); };
        },
      },
      listeners,
      emit: (state: Partial<GameStore>) => listeners.forEach(fn => fn(state as GameStore, state as GameStore)),
    };
  };

  const localState = (over: Partial<GameStore> = {}): Partial<GameStore> => ({
    ...makeGameState({
      players: [makePlayer({ name: 'Alice' })],
      currentPlayerIndex: 0,
      currentCard: '200',
      cards: ['300'],
      round: 1,
      winningScore: 6000,
      initialCards: { '200': 1 },
      finished: false,
      gameTimeInSeconds: 0,
    }),
    mode: 'local',
    randomOrder: false,
    turnDuration: 0,
    reconnectTimeout: 0,
    ruleset: 'modernized',
    ...over,
  });

  beforeEach(() => {
    localStorage.clear();
  });

  const saved = () => JSON.parse(localStorage.getItem('tutto_local_game') ?? 'null');

  it('writes the local game on a real change', () => {
    const { store, emit, listeners } = makeStore();
    attachPersistence(store);
    expect(listeners, 'both subscribers must be registered').toHaveLength(2);

    emit(localState());

    expect(saved()).toMatchObject({ round: 1, currentCard: '200' });
  });

  it('stamps every save with the current schema version', () => {
    const { store, emit } = makeStore();
    attachPersistence(store);

    emit(localState());

    expect(saved()).toMatchObject({ schemaVersion: LOCAL_GAME_SCHEMA_VERSION });
  });

  // The whole reason the stability key exists: the 1s game clock mutates
  // gameTimeInSeconds every tick, and writing the snapshot each time would
  // rewrite localStorage once a second for the length of a game.
  //
  // These tests spread from a single `state` object rather than calling
  // localState() again for each emit: zustand/immer only mints a new
  // reference for the slice a `set` actually touches, so an untouched field
  // (players, cards, ...) keeps its old reference across ticks. Rebuilding
  // the whole fixture from scratch each time (as makeGameState/makePlayer do)
  // would give every field a fresh-but-equal-content reference and defeat the
  // reference/shallow-equality check this subscriber uses to detect a real
  // change cheaply.
  it('does not rewrite when only the game clock ticked', () => {
    const { store, emit } = makeStore();
    attachPersistence(store);
    const state = localState();
    emit(state);

    const writeSpy = vi.spyOn(Storage.prototype, 'setItem');
    emit({ ...state, gameTimeInSeconds: 1 });
    emit({ ...state, gameTimeInSeconds: 2 });

    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  // Proves the detection is cheap, not just correct: an update to a field
  // that was never part of the save (toasts) must not even serialise the
  // state to compare it, let alone write it.
  it('does not stringify or write for a change outside the saved fields, e.g. a toast', () => {
    const { store, emit } = makeStore();
    attachPersistence(store);
    const state = localState();
    emit(state);

    const writeSpy = vi.spyOn(Storage.prototype, 'setItem');
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    emit({ ...state, toasts: [{ id: 1, message: 'hi' }] });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(stringifySpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
    stringifySpy.mockRestore();
  });

  it('carries the latest clock value along the next real change', () => {
    const { store, emit } = makeStore();
    attachPersistence(store);
    const state = localState();
    emit(state);
    emit({ ...state, gameTimeInSeconds: 42 });

    emit({ ...state, gameTimeInSeconds: 42, round: 2 });

    expect(saved()).toMatchObject({ round: 2, gameTimeInSeconds: 42 });
  });

  it('ignores online state entirely, and writes once on returning to local', () => {
    const { store, emit } = makeStore();
    attachPersistence(store);
    const state = localState({ round: 3 });
    emit(state);
    localStorage.clear();

    emit({ ...state, mode: 'online', round: 99 });
    expect(saved(), 'an online snapshot must never reach the local save').toBeNull();

    // Same stable content as before the online detour — it still has to write,
    // because leaving local mode reset the key.
    emit(state);
    expect(saved()).toMatchObject({ round: 3 });
  });

  // storage.ts swallows a refused write (quota, blocked site data) and reports
  // it through the return value. That has to hold HERE above all: this
  // subscriber runs synchronously inside every store mutation, so a throw
  // would surface from committing a turn.
  it('survives a storage backend that refuses to write', () => {
    const { store, emit } = makeStore();
    attachPersistence(store);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => emit(localState())).not.toThrow();

    expect(setItem).toHaveBeenCalled();
    setItem.mockRestore();
  });
});
