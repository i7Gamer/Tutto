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
  it('is true when the OS asks for reduced motion', () => {
    stubMatchMedia(true);

    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false when it does not', () => {
    stubMatchMedia(false);

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
});
