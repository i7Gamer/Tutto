import { useState, useEffect } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Live counterpart to utils/reducedMotion.ts's one-shot prefersReducedMotion():
// that helper is read once per call site (an imperative scroll, say), where a
// stale answer for the rest of the session is harmless. The Animations
// setting in the lobby (LobbyShared.tsx) needs to notice the OS preference
// changing while the lobby is already open — a player who flips their
// system's reduced-motion toggle mid-session should see the setting appear or
// disappear without a reload — hence the subscription here instead of a
// plain read.
//
// Guarded for environments without matchMedia (jsdom provides it only when a
// suite stubs it) and read as "no preference" there, same as the one-shot
// helper.
export function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(() =>
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCED_MOTION_QUERY).matches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = (e: MediaQueryListEvent) => setPrefersReduced(e.matches);

    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  return prefersReduced;
}
