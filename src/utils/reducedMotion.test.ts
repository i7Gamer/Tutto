/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { prefersReducedMotion, scrollBehavior } from './reducedMotion';

// jsdom has no matchMedia unless a suite provides one, which is also the
// shape of a browser too old to know the query — both must read as "no
// preference" rather than throwing.
const stubMatchMedia = (matches: boolean) => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefersReducedMotion', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-motion');
  });

  it('is true when the OS asks for reduced motion', () => {
    stubMatchMedia(true);

    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false when it does not', () => {
    stubMatchMedia(false);

    expect(prefersReducedMotion()).toBe(false);
  });

  // App.tsx sets data-motion="always" on <html> for the lobby's Animations
  // override — the same attribute the CSS half of reduced motion already
  // excludes (see "every selector...excludes the data-motion override"
  // below). This is the third consumer c819e0d didn't wire up: an OS asking
  // for less motion, with the override on, must still read as "no preference"
  // here, the same way the stylesheet and MotionConfig already do.
  it('is false when the lobby override is set, even though the OS asks for reduced motion', () => {
    stubMatchMedia(true);
    document.documentElement.setAttribute('data-motion', 'always');

    expect(prefersReducedMotion()).toBe(false);
  });

  it('asks the query the media feature actually defines', () => {
    // A typo here would silently never match, and the whole feature would be
    // dead with nothing failing.
    stubMatchMedia(true);

    prefersReducedMotion();

    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('reads as no-preference where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);

    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('scrollBehavior', () => {
  it('scrolls instantly under reduced motion', () => {
    stubMatchMedia(true);

    expect(scrollBehavior()).toBe('auto');
  });

  it('scrolls smoothly otherwise', () => {
    stubMatchMedia(false);

    expect(scrollBehavior()).toBe('smooth');
  });
});

// The other half of the feature. <MotionConfig reducedMotion="user"> in App.tsx
// covers everything framer-motion animates and nothing it does not: the
// Tailwind animate-* utilities, this stylesheet's own transitions, and the
// keyframes on the card faces all run regardless. jsdom resolves no
// stylesheet, so what is asserted here is that the rule exists and says the
// right thing — that it takes effect is a browser fact (e2e/styling.spec.ts).
describe('the stylesheet half of reduced motion', () => {
  const css = readFileSync('src/index.css', 'utf8');

  it('carries a prefers-reduced-motion block', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('collapses animations rather than removing them', () => {
    // `animation: none` would strand an element whose only path to its final
    // state is a keyframe at frame zero — invisible, permanently. A near-zero
    // duration runs the whole thing inside one frame instead.
    const block = css.slice(css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/));

    expect(block).toContain('animation-duration');
    expect(block).toContain('transition-duration');
    expect(block).not.toMatch(/animation:\s*none/);
  });

  it('stops smooth scrolling too', () => {
    const block = css.slice(css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/));

    expect(block).toContain('scroll-behavior');
  });

  // Finds the index just past the closing brace that matches the @media
  // block's own opening brace, by counting nested braces from there — the
  // block's real end, rather than a guessed number of characters presumed to
  // reach past it.
  const cssBlockEnd = (source: string, blockStart: number): number => {
    const openBrace = source.indexOf('{', blockStart);
    let depth = 0;
    for (let i = openBrace; i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    throw new Error('unbalanced braces: no closing brace found for the block');
  };

  // B-motion-override: the Animations lobby setting (LobbyShared.tsx's
  // AnimationsSettingSelector) sets data-motion="always" on <html> (App.tsx)
  // when a player wants the animations despite their OS's reduced-motion
  // request. Every selector in this block must exclude that attribute, or the
  // override would do nothing for the CSS half of reduced motion (framer-
  // motion's own MotionConfig is the other half, and reads the store
  // directly rather than the DOM attribute).
  it('every selector in the block excludes the data-motion="always" override', () => {
    const mediaStart = css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const block = css.slice(mediaStart, cssBlockEnd(css, mediaStart));
    const selectorLine = block.slice(block.indexOf('{') + 1, block.indexOf('{', block.indexOf('{') + 1));
    const selectors = selectorLine.split(',').map((s) => s.trim()).filter(Boolean);

    expect(selectors.length).toBeGreaterThan(0);
    selectors.forEach((selector) => {
      expect(selector).toContain(':root:not([data-motion="always"])');
    });
  });
});
