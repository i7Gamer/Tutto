export type Theme = 'light' | 'dark';

const STORED_THEMES: readonly Theme[] = ['light', 'dark'];

/**
 * The theme to apply before the very first render.
 *
 * A stored value is an explicit choice the player already made (App.tsx's
 * toggle writes one to `tutto-theme` on every switch) and always wins, even
 * against a conflicting OS preference — once picked, the app does not follow
 * later system changes, light or dark, for the rest of that choice's
 * lifetime. Only the absence of a stored choice falls through to
 * `prefers-color-scheme`, which is why this takes a snapshot rather than
 * subscribing to the media query: it runs once, at startup.
 *
 * Guarded for environments without matchMedia the way
 * src/utils/reducedMotion.ts guards it — read as light there, the same
 * default the platform itself uses.
 */
export const resolveInitialTheme = (storedTheme: string | null): Theme => {
  if (storedTheme !== null && (STORED_THEMES as string[]).includes(storedTheme)) {
    return storedTheme as Theme;
  }

  const prefersDark =
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;

  return prefersDark ? 'dark' : 'light';
};
