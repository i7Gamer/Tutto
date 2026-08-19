import { describe, it, expect } from 'vitest';
import {
  contrastRatio,
  fitToContrast,
  readableNameVars,
  NAME_CONTRAST_TARGET,
  LIGHT_SURFACE,
  DARK_SURFACE,
} from './contrastColor';
import { PLAYER_COLORS } from '../store/gameSlice';

describe('contrastRatio', () => {
  // The two anchors of the WCAG scale, so a sign error or a swapped pair
  // cannot pass: black on white is the maximum, and any colour on itself is
  // the minimum.
  it('spans 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2);
    expect(contrastRatio('#7f7f7f', '#7f7f7f')).toBeCloseTo(1, 5);
  });

  it('is symmetric — neither argument is privileged', () => {
    expect(contrastRatio('#FFD700', '#1c2638')).toBeCloseTo(contrastRatio('#1c2638', '#FFD700'), 10);
  });

  it('accepts uppercase and lowercase hex alike', () => {
    expect(contrastRatio('#ffd700', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFD700', '#ffffff'), 10);
  });

  // The measured figures the whole change is argued from — pinned so a later
  // edit to the luminance maths has to move these numbers deliberately.
  it('reproduces the measured figures for the shipped palette', () => {
    expect(contrastRatio('#FFD700', LIGHT_SURFACE)).toBeCloseTo(1.40, 2);
    expect(contrastRatio('#FFD700', DARK_SURFACE)).toBeCloseTo(10.82, 2);
    expect(contrastRatio('#3357FF', LIGHT_SURFACE)).toBeCloseTo(5.32, 2);
    expect(contrastRatio('#3357FF', DARK_SURFACE)).toBeCloseTo(2.85, 2);
  });

  it('returns 1 for an unparseable colour rather than NaN', () => {
    // NaN would propagate silently through every >= comparison in the fit
    // below and read as "never passes", so it is pinned to the safe extreme.
    expect(contrastRatio('not-a-colour', '#ffffff')).toBe(1);
    expect(contrastRatio('#fff', '#ffffff')).toBe(1);
  });
});

describe('fitToContrast', () => {
  it('leaves a colour that already clears the target untouched', () => {
    // Gold on the dark surface is 10.82:1 — nothing to fix, and changing it
    // would cost the player their colour for no reason.
    expect(fitToContrast('#FFD700', DARK_SURFACE, NAME_CONTRAST_TARGET)).toBe('#FFD700');
  });

  it('darkens against a light surface and lightens against a dark one', () => {
    const onLight = fitToContrast('#FFD700', LIGHT_SURFACE, NAME_CONTRAST_TARGET);
    const onDark = fitToContrast('#3357FF', DARK_SURFACE, NAME_CONTRAST_TARGET);
    expect(contrastRatio(onLight, LIGHT_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    expect(contrastRatio(onDark, DARK_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    // ...and moved in the direction that makes sense for each ground.
    expect(contrastRatio(onLight, '#000000')).toBeLessThan(contrastRatio('#FFD700', '#000000'));
    expect(contrastRatio(onDark, '#ffffff')).toBeLessThan(contrastRatio('#3357FF', '#ffffff'));
  });

  // The point of moving lightness rather than picking a replacement colour:
  // the player still reads as "the gold one".
  it('preserves hue and saturation', () => {
    const fitted = fitToContrast('#FFD700', LIGHT_SURFACE, NAME_CONTRAST_TARGET);
    // #FFD700 is hue 50.6deg, fully saturated. Its fitted form must be the
    // same hue family: red highest, then green, then no blue at all.
    const [r, g, b] = [1, 3, 5].map(i => parseInt(fitted.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(b).toBe(0);
  });

  it('clears the target for every colour in the shipped palette, on both surfaces', () => {
    for (const color of PLAYER_COLORS) {
      for (const surface of [LIGHT_SURFACE, DARK_SURFACE]) {
        const fitted = fitToContrast(color, surface, NAME_CONTRAST_TARGET);
        expect(
          contrastRatio(fitted, surface),
          `${color} on ${surface} -> ${fitted}`,
        ).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
      }
    }
  });

  // The picker is a free-form <input type="color">, so the guarantee has to
  // hold for colours nobody chose from the palette — including the two that
  // are exactly the surfaces themselves.
  it('rescues the worst legal picks: the surface colour itself', () => {
    expect(contrastRatio(fitToContrast('#ffffff', LIGHT_SURFACE, NAME_CONTRAST_TARGET), LIGHT_SURFACE))
      .toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    expect(contrastRatio(fitToContrast(DARK_SURFACE, DARK_SURFACE, NAME_CONTRAST_TARGET), DARK_SURFACE))
      .toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
  });

  it('holds for an exhaustive sweep of hues at full and half saturation', () => {
    const samples: string[] = [];
    for (let h = 0; h < 360; h += 5) {
      for (const [s, l] of [[100, 50], [50, 50], [100, 85], [100, 15]] as const) {
        samples.push(hslHex(h, s, l));
      }
    }
    for (const color of samples) {
      for (const surface of [LIGHT_SURFACE, DARK_SURFACE]) {
        expect(
          contrastRatio(fitToContrast(color, surface, NAME_CONTRAST_TARGET), surface),
          `${color} on ${surface}`,
        ).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
      }
    }
  });

  it('returns an unparseable colour unchanged rather than inventing one', () => {
    expect(fitToContrast('rebeccapurple', LIGHT_SURFACE, NAME_CONTRAST_TARGET)).toBe('rebeccapurple');
  });
});

describe('readableNameVars', () => {
  it('gives both surfaces their own fitted value', () => {
    const vars = readableNameVars('#FFD700');
    expect(contrastRatio(vars['--player-name-light'], LIGHT_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    expect(contrastRatio(vars['--player-name-dark'], DARK_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    // Gold already passes on the dark card, so only the light half moves.
    expect(vars['--player-name-dark']).toBe('#FFD700');
    expect(vars['--player-name-light']).not.toBe('#FFD700');
  });

  // A player with no colour yet fell back to a near-black in the lobby, which
  // is itself unreadable on the dark card — the fit covers that too.
  it('rescues the colourless fallback on the dark surface', () => {
    const vars = readableNameVars(undefined);
    expect(contrastRatio(vars['--player-name-light'], LIGHT_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    expect(contrastRatio(vars['--player-name-dark'], DARK_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
  });

  it('names the two custom properties the stylesheet reads', () => {
    // The pairing is split across a TS file and a CSS rule that jsdom cannot
    // resolve, so the property names are pinned on this side at least.
    expect(Object.keys(readableNameVars('#FF5733')).sort())
      .toEqual(['--player-name-dark', '--player-name-light']);
  });
});

// Local HSL -> hex, so the sweep above generates its samples independently of
// the conversion under test.
function hslHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const rgb = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  return '#' + rgb.map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
