/**
 * Every localStorage and sessionStorage touch in the app goes through here.
 *
 * Web storage throws for reasons that have nothing to do with a full quota:
 * site data blocked for the origin (the property access itself throws, before
 * any method runs), a third-party context, Firefox's dom.storage.enabled=false.
 * Only one call site in the app used to account for that, so a refusal
 * anywhere else did not merely lose a saved game — it propagated into whatever
 * happened to be writing. The two worst places for that are the persistence
 * subscribers, which write synchronously inside every store mutation (so a
 * throw surfaces from committing a turn), and ErrorBoundary.componentDidCatch,
 * which writes while React is already handling a crash.
 *
 * Losing persistence is always the acceptable outcome; failing the action that
 * happened to write is not. Callers that show the player what is stored (the
 * recent-rooms list) can tell the two apart from `write`'s return value.
 */

type StorageKind = 'localStorage' | 'sessionStorage';

export interface SafeStorage {
  /** The stored string, or null if absent OR unreadable. */
  read: (key: string) => string | null;
  /** Whether the value is actually stored now. */
  write: (key: string, value: string) => boolean;
  remove: (key: string) => void;
}

const makeSafeStorage = (kind: StorageKind): SafeStorage => {
  // Resolved per call, not once at module load: a blocked-storage verdict can
  // differ by the time the app is interactive, and reading it eagerly would
  // throw during module evaluation — before any try/catch of ours exists.
  const backend = (): Storage | null => {
    try {
      return window[kind];
    } catch {
      return null;
    }
  };

  return {
    read: (key) => {
      try {
        return backend()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write: (key, value) => {
      try {
        const storage = backend();
        if (!storage) return false;
        storage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    remove: (key) => {
      try {
        backend()?.removeItem(key);
      } catch {
        // Nothing left to lose: the entry is either already gone or
        // unreachable, and both mean the same thing to every caller.
      }
    },
  };
};

export const localStore = makeSafeStorage('localStorage');
export const sessionStore = makeSafeStorage('sessionStorage');
