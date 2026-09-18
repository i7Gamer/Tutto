import { useGameStore } from '../store/useGameStore';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Whether reduced motion is in effect right now: the OS asks for it AND the
 * lobby's Animations override ("Always on", configSlice.motionOverride) is
 * not set. This is the same reading <MotionConfig> in App.tsx and the
 * stylesheet's `:root:not([data-motion="always"])` guard make — for a
 * component that wants to drop, not merely still, a purely animated element.
 *
 * Not usePrefersReducedMotion() alone: that is the raw OS preference, which
 * the Animations setting (LobbyShared.tsx) needs unfiltered to decide whether
 * to show itself at all.
 */
export function useReducedMotionActive(): boolean {
  const prefersReduced = usePrefersReducedMotion();
  const motionOverride = useGameStore((s) => s.motionOverride);
  return prefersReduced && !motionOverride;
}
