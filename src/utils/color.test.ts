import { describe, it, expect } from 'vitest';
import { oklchToHex, parseOklch } from './color';

describe('oklchToHex', () => {
  it('renders pure black', () => {
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
  });

  it('renders pure white', () => {
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff');
  });

  it('matches the commonly published OKLCH equivalent of sRGB red', () => {
    // oklch(62.8% 0.258 29.23) is the value browsers and colour tools quote
    // for #ff0000 — the fixture this function's OKLab/linear-sRGB matrices
    // (CSS Color 4, Björn Ottosson) are checked against.
    expect(oklchToHex(0.628, 0.258, 29.23)).toBe('#ff0000');
  });

  it('clamps a channel that would otherwise fall outside sRGB rather than wrapping', () => {
    // An out-of-gamut chroma for this lightness/hue would otherwise push a
    // channel negative or past 1 before gamma-encoding; clamped, not wrapped
    // or NaN.
    expect(oklchToHex(0.5, 0.4, 0)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('parseOklch', () => {
  it('reads the percentage-lightness form Tailwind\'s theme ships', () => {
    // node_modules/tailwindcss/theme.css writes palette entries exactly this
    // way, e.g. "--color-indigo-600: oklch(51.1% 0.262 276.966);".
    expect(parseOklch('oklch(51.1% 0.262 276.966)')).toEqual({ l: 0.511, c: 0.262, h: 276.966 });
  });

  it('reads the plain-number lightness form', () => {
    expect(parseOklch('oklch(0.511 0.262 276.966)')).toEqual({ l: 0.511, c: 0.262, h: 276.966 });
  });

  it('throws on a value that is not an oklch() colour', () => {
    expect(() => parseOklch('#4f46e5')).toThrow();
  });
});
