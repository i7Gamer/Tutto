/**
 * Making a player's own colour readable as text.
 *
 * Every player picks a colour and their name is drawn in it. The picker is a
 * free-form `<input type="color">`, and measured against the two surfaces a
 * name is ever drawn on, not one colour in the shipped palette clears 4.5:1 in
 * BOTH themes — the two that pass on the light card are the two that fail on
 * the dark one, and a player is free to pick pure white (1:1) besides.
 *
 * The fix keeps hue and saturation and moves only lightness, so the player
 * still reads as "the gold one" while the name stays legible. Dropping the
 * colour from the text entirely would have been simpler; it would also have
 * cost the roster the thing it is colour-coded for.
 *
 * Darkening the light SURFACE instead does not work, which is worth recording
 * because it is the obvious first idea: contrast is a ratio between two
 * luminances, so pulling the ground down towards a bright colour closes the
 * gap before it opens it. Gold falls from 1.40:1 on white to 1.04:1 around
 * #D0D6DC and only recovers once the card is mid-grey — by which point it is
 * not a light theme and the body ink has lost half its own contrast.
 */

/**
 * The ratio a fitted name must clear.
 *
 * WCAG's floor for body text is 4.5:1, and the large-text allowance (3:1)
 * would even cover the scoreboard's 24px name. 5.5 is deliberately above both,
 * and not for the safety margin: at exactly 4.5 the blues already pass on the
 * light card and are left untouched while gold and cyan are pushed deep, so a
 * roster mixing them reads as two different decisions sitting side by side.
 * The higher floor moves the blues slightly too and the set closes ranks.
 *
 * Higher is not better past this point — at 7:1 the hue starts going with the
 * lightness (gold reads olive, cyan reads bottle green) and the colour stops
 * identifying the player, which is the whole reason for fitting rather than
 * just using ink.
 */
export const NAME_CONTRAST_TARGET = 5.5;

/** The light card a name sits on: `bg-white`, opaque. */
export const LIGHT_SURFACE = '#ffffff';

/**
 * The dark card, flattened. The real surfaces are translucent over
 * `--bg-color` (`--card-bg` at 0.85, the scoreboard tile at 0.80), which land
 * within a unit per channel of each other — far below anything the fit below
 * can resolve, so one blended value stands for both.
 */
export const DARK_SURFACE = '#1c2638';

/** How finely lightness is swept. 1% steps are already below what the eye reads as a step. */
const LIGHTNESS_STEP = 0.01;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type Rgb = readonly [number, number, number];

const parseHex = (hex: string): Rgb | null => {
  if (!HEX_RE.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ] as const;
};

const toHex = ([r, g, b]: Rgb): string =>
  '#' + [r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('');

/** WCAG 2.1 relative luminance. */
const channelLuminance = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);

/**
 * WCAG 2.1 contrast ratio, 1:1 (identical) to 21:1 (black on white).
 *
 * An unparseable colour answers 1 rather than NaN: NaN survives every `>=`
 * comparison as false, so the fit below would read it as "never passes" and
 * sweep to an extreme instead of leaving the value alone.
 */
export const contrastRatio = (a: string, b: string): number => {
  const rgbA = parseHex(a);
  const rgbB = parseHex(b);
  if (!rgbA || !rgbB) return 1;
  const [lighter, darker] = [luminance(rgbA), luminance(rgbB)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

const rgbToHsl = ([r, g, b]: Rgb): [number, number, number] => {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rN) h = (gN - bN) / d + (gN < bN ? 6 : 0);
  else if (max === gN) h = (bN - rN) / d + 2;
  else h = (rN - gN) / d + 4;
  return [h / 6, s, l];
};

const hueToChannel = (p: number, q: number, tRaw: number): number => {
  let t = tRaw;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

const hslToRgb = ([h, s, l]: [number, number, number]): Rgb => {
  if (s === 0) return [l * 255, l * 255, l * 255] as const;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToChannel(p, q, h + 1 / 3) * 255,
    hueToChannel(p, q, h) * 255,
    hueToChannel(p, q, h - 1 / 3) * 255,
  ] as const;
};

/**
 * `color` moved just far enough along its own lightness axis to clear `target`
 * against `surface`, or returned untouched when it already does.
 *
 * Which way to move is decided by the surface, not by the colour: on a light
 * ground the only direction that can ever reach the target is down, and on a
 * dark ground, up. Both are always reachable — black on white is 21:1 and
 * white on the dark card is 14.4:1, well past any target this app asks for —
 * but the sweep still ends at the extreme rather than running off, so a target
 * raised past what a surface can offer degrades to "as readable as possible"
 * instead of returning the unreadable original.
 */
export const fitToContrast = (color: string, surface: string, target: number): string => {
  const rgb = parseHex(color);
  const surfaceRgb = parseHex(surface);
  if (!rgb || !surfaceRgb) return color;
  if (contrastRatio(color, surface) >= target) return color;

  const towardsDarker = luminance(surfaceRgb) > luminance([0, 0, 0]) + 0.18;
  const [h, s, l0] = rgbToHsl(rgb);
  const limit = towardsDarker ? l0 : 1 - l0;

  let best = towardsDarker ? '#000000' : '#ffffff';
  for (let moved = LIGHTNESS_STEP; moved <= limit; moved += LIGHTNESS_STEP) {
    const candidate = toHex(hslToRgb([h, s, towardsDarker ? l0 - moved : l0 + moved]));
    if (contrastRatio(candidate, surface) >= target) return candidate;
    best = candidate;
  }
  // The sweep ran out of lightness before reaching the target: fall back to
  // the extreme, which is the most readable this hue can be on this ground.
  return contrastRatio(best, surface) >= contrastRatio(towardsDarker ? '#000000' : '#ffffff', surface)
    ? best
    : (towardsDarker ? '#000000' : '#ffffff');
};

/**
 * The inline custom properties a player-coloured name carries, one per theme.
 *
 * Both are computed here rather than one being picked at render time because
 * the component has no idea which theme is showing — the app writes
 * `data-theme` on `<html>` (App.tsx) and the `.player-name` rule in index.css
 * chooses between these two. That keeps a theme toggle a pure CSS switch, with
 * no React state to thread down and no re-render.
 */
export const readableNameVars = (color: string | null | undefined): Record<string, string> => {
  // The colourless fallback used to be a near-black, which is itself
  // unreadable on the dark card — so it goes through the same fit.
  const base = color ?? '#1f2937';
  return {
    '--player-name-light': fitToContrast(base, LIGHT_SURFACE, NAME_CONTRAST_TARGET),
    '--player-name-dark': fitToContrast(base, DARK_SURFACE, NAME_CONTRAST_TARGET),
  };
};
