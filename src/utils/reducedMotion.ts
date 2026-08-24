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
 * platform uses.
 */
export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The ScrollBehavior to pass to scrollIntoView / scrollTo. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');
