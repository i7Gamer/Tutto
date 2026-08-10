import { describe, it, expect, afterEach } from 'vitest';
import { localStore, sessionStore } from './storage';
import { blockStorage, failStorageMethods, restoreStorage } from '../testing/storageStubs';

afterEach(() => {
  restoreStorage();
  localStorage.clear();
  sessionStorage.clear();
});

describe.each([
  ['localStore', localStore, () => localStorage, 'localStorage' as const],
  ['sessionStore', sessionStore, () => sessionStorage, 'sessionStorage' as const],
])('%s', (_name, store, backend, propertyName) => {
  it('round-trips a value', () => {
    expect(store.write('k', 'v')).toBe(true);
    expect(store.read('k')).toBe('v');
    expect(backend().getItem('k')).toBe('v');
  });

  it('reads a missing key as null', () => {
    expect(store.read('nope')).toBeNull();
  });

  it('removes a value', () => {
    store.write('k', 'v');
    store.remove('k');
    expect(store.read('k')).toBeNull();
  });

  it('reports a refused write rather than throwing', () => {
    failStorageMethods(propertyName, ['setItem']);

    expect(() => store.write('k', 'v')).not.toThrow();
    expect(store.write('k', 'v')).toBe(false);
  });

  it('reads null rather than throwing when getItem fails', () => {
    failStorageMethods(propertyName, ['getItem']);

    expect(store.read('k')).toBeNull();
  });

  it('swallows a failing remove — there is nothing left to lose', () => {
    failStorageMethods(propertyName, ['removeItem']);

    expect(() => store.remove('k')).not.toThrow();
  });

  it('survives the storage property itself throwing', () => {
    blockStorage(propertyName);

    expect(store.read('k')).toBeNull();
    expect(store.write('k', 'v')).toBe(false);
    expect(() => store.remove('k')).not.toThrow();
  });

  it('resolves the backend per call, so a mid-session block is picked up', () => {
    expect(store.write('k', 'v')).toBe(true);
    blockStorage(propertyName);
    expect(store.read('k')).toBeNull();
    restoreStorage();
    expect(store.read('k')).toBe('v');
  });
});
