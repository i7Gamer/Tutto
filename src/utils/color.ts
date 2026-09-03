/**
 * OKLCH -> sRGB hex, and a minimal parser for the `oklch(...)` strings
 * Tailwind's shipped palette (node_modules/tailwindcss/theme.css) writes its
 * colours in.
 *
 * Exists so a plain-text test (src/pwaManifestColors.test.ts) can prove the
 * PWA manifest's brand colours (vite.config.ts) have not drifted from what
 * `--primary` in src/index.css actually resolves to. `--primary` reads
 * Tailwind's `--color-indigo-600` rather than a literal hex specifically so
 * it never drifts from the live palette (see the comment above `:root` in
 * index.css) — which means there is no literal hex to compare the manifest
 * against by parsing index.css text alone. Tailwind's theme.css is itself
 * static, checked-in text (no build step needed to read it), so this
 * resolves the one non-literal step in an otherwise pure text-parsing check.
 *
 * The OKLab <-> linear-sRGB matrices below are the CSS Color 4 ones
 * (Björn Ottosson) — the same math browsers use — verified in color.test.ts
 * by round-tripping the commonly published OKLCH equivalent of sRGB red.
 */

export interface Oklch {
  /** 0-1 fraction, already normalised out of a percentage if the source had one. */
  l: number;
  c: number;
  /** Degrees. */
  h: number;
}

const OKLCH_PATTERN = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i;

/** Parses `oklch(L C H)`, accepting L as either a percentage or a 0-1 number. */
export const parseOklch = (value: string): Oklch => {
  const match = OKLCH_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Not an oklch() colour: ${value}`);

  const [, lRaw, lIsPercent, cRaw, hRaw] = match;
  const l = lIsPercent === '%' ? Number(lRaw) / 100 : Number(lRaw);
  return { l, c: Number(cRaw), h: Number(hRaw) };
};

/** sRGB gamma encoding (the piecewise CSS Color 4 / IEC 61966-2-1 transfer function). */
const gammaEncode = (linear: number): number => {
  const clamped = Math.max(0, Math.min(1, linear));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
};

const toHexByte = (channel: number): string =>
  Math.round(channel * 255).toString(16).padStart(2, '0');

/** OKLCH -> `#rrggbb`. `l` is a 0-1 fraction, `c` is chroma, `h` is hue in degrees. */
export const oklchToHex = (l: number, c: number, h: number): string => {
  const hueRadians = h * (Math.PI / 180);
  const a = c * Math.cos(hueRadians);
  const b = c * Math.sin(hueRadians);

  // OKLab -> LMS (cube-rooted).
  const lLms = l + 0.3963377774 * a + 0.2158037573 * b;
  const mLms = l - 0.1055613458 * a - 0.0638541728 * b;
  const sLms = l - 0.0894841775 * a - 1.2914855480 * b;

  // LMS -> linear sRGB.
  const lCubed = lLms ** 3;
  const mCubed = mLms ** 3;
  const sCubed = sLms ** 3;
  const linearRed = 4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed;
  const linearGreen = -1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed;
  const linearBlue = -0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.7076147010 * sCubed;

  return '#'
    + toHexByte(gammaEncode(linearRed))
    + toHexByte(gammaEncode(linearGreen))
    + toHexByte(gammaEncode(linearBlue));
};
