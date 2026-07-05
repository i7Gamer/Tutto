import { useEffect } from 'react';

// Keeps the screen from dimming/locking while active — used for the whole
// gameplay session (Game.tsx mounts exactly when a game starts and unmounts
// when it ends), so both the host and every client keep their own device
// awake independently; there's no host-only or server-side piece to this.
export function useWakeLock(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const requestLock = async () => {
      try {
        const s = await navigator.wakeLock.request('screen');
        if (cancelled) {
          // Effect was cleaned up (Game unmounted) while the request was
          // still in flight — release immediately instead of holding a lock
          // for a screen that's no longer in an active game.
          void s.release();
          return;
        }
        sentinel = s;
        // The browser fires this for both an explicit release() call (ours,
        // below) and its own automatic release on backgrounding — without
        // clearing the reference here, a browser-initiated release would
        // leave `sentinel` non-null, and handleVisibilityChange's `!sentinel`
        // check would then never re-request the lock on return.
        s.addEventListener('release', () => { sentinel = null; });
      } catch (err) {
        // Requests can be rejected (low battery, permissions policy, etc.) —
        // this must not crash the game, just silently go without a lock.
        console.error('Could not acquire screen wake lock', err);
      }
    };

    void requestLock();

    // The browser releases the lock automatically whenever the tab is
    // backgrounded (app-switch, the OS screen-lock button, an incoming call,
    // etc.) and never re-acquires it on its own — without this, the screen
    // could go back to sleeping normally for the rest of the game after any
    // brief backgrounding.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !sentinel) {
        void requestLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (sentinel) {
        void sentinel.release();
        sentinel = null;
      }
    };
  }, []);
}
