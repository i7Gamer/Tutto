/**
 * Test support for the storage-refusal paths (see utils/storage.ts).
 *
 * The whole `window.localStorage` / `window.sessionStorage` property is
 * replaced rather than its methods spied on: jsdom implements Storage as a
 * proxy that silently swallows a vi.spyOn install — the spy is never even
 * added as an own property — so a method-level mock does nothing at all.
 * Replacing the property is also closer to the real failure, where site-data
 * blocking makes the getter itself throw.
 *
 * Not imported by any application module; it lives outside utils/ so that is
 * obvious at a glance.
 */

export type StorageProperty = 'localStorage' | 'sessionStorage';
export type StorageMethod = 'getItem' | 'setItem' | 'removeItem';

/** Undoes every stub installed since the last call. Use in afterEach. */
export const restoreStorage = (): void => {
  restorers.splice(0).forEach(restore => restore());
};

const restorers: (() => void)[] = [];

const replaceProperty = (name: StorageProperty, get: () => Storage): void => {
  const original = Object.getOwnPropertyDescriptor(window, name);
  Object.defineProperty(window, name, { configurable: true, get });
  restorers.push(() => {
    if (original) Object.defineProperty(window, name, original);
  });
};

/** Site data blocked for the origin: reading the property throws. */
export const blockStorage = (name: StorageProperty): void =>
  replaceProperty(name, () => { throw new Error('site data blocked'); });

/** A backend whose named methods throw; the rest are inert. */
export const failStorageMethods = (name: StorageProperty, failing: StorageMethod[]): void => {
  const throwing = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  const stub = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as unknown as Storage;
  for (const method of failing) {
    (stub as unknown as Record<string, unknown>)[method] = throwing;
  }
  replaceProperty(name, () => stub);
};
