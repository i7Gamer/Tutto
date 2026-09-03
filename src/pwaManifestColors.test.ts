/** @vitest-environment node */
/**
 * B58: the PWA manifest's theme_color/background_color (vite.config.ts) must
 * be the light theme's actual header/page colours, but neither is a literal
 * this file can just import from src/index.css:
 *
 *  - --bg-color IS a literal there, so that half is a plain text comparison.
 *  - --primary reads Tailwind's own `--color-indigo-600` rather than a copied
 *    hex — deliberately, per the comment above :root in index.css, so it
 *    never goes stale the way --secondary already warns it could. That
 *    leaves nothing literal in index.css to compare theme_color against.
 *
 * Rather than inventing a shared brand module CSS cannot import from (plain
 * CSS has no way to read a JS/TS value), this resolves the one non-literal
 * step from Tailwind's own theme.css — static, checked-in text, no build
 * required — and treats index.css plus that file as the two sources of
 * truth. A manifest value that drifts from either fails here instead of
 * silently shipping a theme_color the app no longer looks like.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { oklchToHex, parseOklch } from './utils/color';

const REPO_ROOT = path.resolve(__dirname, '..');

const readManifestSource = (): string =>
  fs.readFileSync(path.join(REPO_ROOT, 'vite.config.ts'), 'utf8');

const readIndexCss = (): string =>
  fs.readFileSync(path.join(REPO_ROOT, 'src', 'index.css'), 'utf8');

const readTailwindTheme = (): string =>
  fs.readFileSync(path.join(REPO_ROOT, 'node_modules', 'tailwindcss', 'theme.css'), 'utf8');

/** A `key: 'value'` (or `"value"`) pair in the manifest object literal. */
const manifestField = (source: string, key: string): string | null => {
  const match = new RegExp(`${key}:\\s*['"]([^'"]+)['"]`).exec(source);
  return match ? (match[1] as string) : null;
};

/**
 * The value of a custom property inside the FIRST `:root { ... }` block —
 * the light theme, which in index.css comes before the `[data-theme="dark"]`
 * override. A naive whole-file regex would risk matching the dark block's
 * copy of a property that happens to share a name.
 */
const lightThemeCustomProperty = (css: string, property: string): string | null => {
  const rootBlock = /:root\s*\{([^}]*)\}/.exec(css);
  if (!rootBlock) return null;
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(rootBlock[1] as string);
  return match ? (match[1] as string).trim() : null;
};

/** A `--color-<name>: oklch(...)` entry from Tailwind's static default theme. */
const tailwindPaletteOklch = (themeCss: string, colorVariable: string): string => {
  const match = new RegExp(`${colorVariable}:\\s*(oklch\\([^)]+\\));`).exec(themeCss);
  if (!match) throw new Error(`${colorVariable} not found in tailwindcss/theme.css`);
  return match[1] as string;
};

describe('PWA manifest colours match src/index.css', () => {
  const manifestSource = readManifestSource();
  const indexCss = readIndexCss();

  it('has a light-theme :root block to read from', () => {
    // Guards the two helpers above against ever silently reading nothing —
    // a stylesheet reorganised so :root moves or disappears would otherwise
    // pass every assertion below by comparing null to null.
    expect(lightThemeCustomProperty(indexCss, '--bg-color')).not.toBeNull();
  });

  it('sets background_color to the light theme\'s body background (--bg-color)', () => {
    const bgColor = lightThemeCustomProperty(indexCss, '--bg-color');
    expect(manifestField(manifestSource, 'background_color')).toBe(bgColor);
  });

  it('sets theme_color to what --primary (Tailwind\'s indigo-600) actually renders', () => {
    // --primary: var(--color-indigo-600) in index.css's light :root block —
    // confirmed literally, so a future change to point --primary elsewhere
    // fails this assertion rather than silently comparing against the wrong
    // palette entry.
    expect(lightThemeCustomProperty(indexCss, '--primary')).toBe('var(--color-indigo-600)');

    const { l, c, h } = parseOklch(tailwindPaletteOklch(readTailwindTheme(), '--color-indigo-600'));
    const expectedHex = oklchToHex(l, c, h);

    expect(manifestField(manifestSource, 'theme_color')?.toLowerCase()).toBe(expectedHex);
  });

  it('drops lang rather than shipping vite-plugin-pwa\'s "en" default', () => {
    // The app is bilingual (src/i18n.test.ts) — `lang: undefined` in the
    // manifest object overrides the plugin's default and JSON.stringify
    // omits it, but only if the key is actually present and set that way.
    expect(manifestSource).toMatch(/lang:\s*undefined/);
  });
});

// iOS ignores the web-app manifest's icons for the home-screen tile and reads
// only <link rel="apple-touch-icon">. Apple's nominal size is 180x180, but
// Safari scales any square PNG it is given; the 192 icon the manifest already
// ships is reused rather than adding a second binary the icon script (which
// needs sharp) would have to regenerate.
describe('the home-screen icon for iOS', () => {
  const APPLE_TOUCH_ICON_PATTERN = /<link\s+rel="apple-touch-icon"[^>]*href="([^"]+)"/;
  const indexHtml = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');

  it('is linked from index.html and points at a PNG that exists in public/', () => {
    const match = APPLE_TOUCH_ICON_PATTERN.exec(indexHtml);
    expect(match, 'index.html has no <link rel="apple-touch-icon">').not.toBeNull();
    const href = match![1];
    expect(href.endsWith('.png')).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'public', href.replace(/^\//, '')))).toBe(true);
  });
});

// Everything under public/ is copied into dist/ verbatim, and server/index.ts
// serves dist/assets/ as immutable for a year on the promise that Vite named
// every file there by a content hash. A stable-named file under public/assets/
// would inherit that header and stay stale for a year after it changed — the
// icons lived there once. Keep public/assets/ empty (or absent).
describe('public/assets/ holds no stable-named files', () => {
  it('is empty or absent', () => {
    const dir = path.join(REPO_ROOT, 'public', 'assets');
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(entries).toEqual([]);
  });
});
