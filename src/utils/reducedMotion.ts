// The value of <html>'s data-motion attribute App.tsx sets for the lobby's
// Animations override (LobbyShared.tsx's AnimationsSettingSelector) — the
// same one the CSS half of reduced motion excludes (index.css's
// `:root:not([data-motion="always"])` guard, pinned in reducedMotion.test.ts).
// MotionConfig reads the store directly for its own half rather than this DOM
// attribute.
const MOTION_OVERRIDE_ALWAYS_VALUE = 'always';

/**
 * Whether the user asked for less motion.
 *
 * framer-motion has its own reading of this (see <MotionConfig
 * reducedMotion="user"> in App.tsx) and CSS has the media query in index.css.
 * This is for the third case neither covers: an imperative browser API that
 * takes its own behaviour argument, where `scroll-behavior: auto` in a
 * stylesheet is simply not consulted.
 *
 * Guarded for environments without matchMedia (jsdom provides it only when a
 * suite stubs it), and treated as "no preference" there — the same default the
 * platform uses. Also honours the Animations override the other two halves
 * already do: with it set, this reads as "no preference" too, regardless of
 * what the OS asks for.
 */
export const prefersReducedMotion = (): boolean => {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === MOTION_OVERRIDE_ALWAYS_VALUE) {
    return false;
  }
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

/** The ScrollBehavior to pass to scrollIntoView / scrollTo. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');
