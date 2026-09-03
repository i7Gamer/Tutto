/** @vitest-environment node */
/**
 * Guards the one lazy boundary that actually costs bytes on the critical path.
 *
 * chart.js + react-chartjs-2 is the single largest dependency the app has
 * (~172 kB raw / ~60 kB gzipped) and only two screens use it — the end screen
 * and the statistics page, which most sessions reach once, at the end, if at
 * all. It was carved into its own `charts` manual chunk, which reads as
 * lazy-loading and was not: App.tsx imported both screens statically, so the
 * chunk sat in the entry's modulepreload set and every player downloaded a
 * charting library before the home screen painted.
 *
 * The manual chunk was the second half of the problem, not the fix. A named
 * chunk is assigned regardless of how the module is reached, so it stayed
 * preloaded even after the imports went lazy — the same trap vite.config.ts's
 * LAZY_PACKAGES note already describes for the QR encoder and decoder. Both
 * halves have to hold, so this checks the built output rather than the source:
 * either the bytes are on the critical path or they are not.
 *
 * ci.yml builds before it runs the suite, so dist/ is present there. Locally it
 * skips rather than forcing a build for every unrelated test run — `npm run
 * build` first if you want it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DIST = path.resolve(__dirname, '..', '..', 'dist');
const INDEX_HTML = path.join(DIST, 'index.html');
// A real build, not the stubs server/api.test.ts writes for its SPA-fallback
// and cache-header probes (dist/index.html and dist/assets/x.abc123.js): those
// used to read as "built" and fail the self-oracle below in any checkout
// without a build. Only Vite's hashed entry chunk proves a build happened.
const ENTRY_CHUNK = /^index-[\w-]+\.js$/;
const built = fs.existsSync(INDEX_HTML)
  && fs.existsSync(path.join(DIST, 'assets'))
  && fs.readdirSync(path.join(DIST, 'assets')).some(file => ENTRY_CHUNK.test(file));

// A chart.js internal that survives minification and appears nowhere else.
const CHARTJS_FINGERPRINT = '_metasets';

// chart.js's own sole dependency, and the half a single chart.js fingerprint
// cannot see. It is a TRANSITIVE package: nothing in this app's source imports
// it, so it has no call site of its own to make lazy and nothing about the
// dynamic imports moves it — it ships on every load unless vite.config.ts
// names it in LAZY_PACKAGES, which is exactly the regression this file exists
// to catch and could not. Taken from @kurkle/color's HUE_RE because a regex
// literal is not rewritten by the minifier, and this alternation appears in no
// other package.
const KURKLE_COLOR_FINGERPRINT = 'hsla?|hwb|hsv';

/** Both halves of the charting bundle, each with the string that proves it. */
const CHART_FINGERPRINTS = [
  ['chart.js', CHARTJS_FINGERPRINT],
  ['@kurkle/color', KURKLE_COLOR_FINGERPRINT],
] as const;

describe.skipIf(!built)('the charts bundle stays off the critical path', () => {
  /** Every script the browser fetches before it can render anything. */
  const criticalPathScripts = (): string[] => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    return [...html.matchAll(/(?:modulepreload"?[^>]*|<script[^>]*)href="([^"]+)"|<script[^>]*src="([^"]+)"/g)]
      .map(match => match[1] ?? match[2])
      .filter((href): href is string => !!href && href.endsWith('.js'))
      .map(href => path.join(DIST, href.replace(/^\.?\//, '')))
      .filter(file => fs.existsSync(file));
  };

  it('finds the scripts it is meant to be checking', () => {
    // The self-oracle: an index.html this regex cannot read would otherwise
    // report a perfectly split bundle.
    expect(criticalPathScripts().length).toBeGreaterThan(0);
  });

  it('has the charting library and its dependency somewhere in the build', () => {
    // The other half of the oracle: if either package were dropped entirely —
    // or a version bump renamed the string being looked for — the check below
    // would pass for the wrong reason.
    const bundles = fs.readdirSync(path.join(DIST, 'assets'))
      .filter(file => file.endsWith('.js'))
      .map(file => fs.readFileSync(path.join(DIST, 'assets', file), 'utf8'));

    for (const [pkg, fingerprint] of CHART_FINGERPRINTS) {
      expect(
        bundles.filter(source => source.includes(fingerprint)).length,
        `${pkg} is nowhere in the build — its fingerprint has gone stale`,
      ).toBeGreaterThan(0);
    }
  });

  it('does not put either of them in anything the first paint waits for', () => {
    const scripts = criticalPathScripts()
      .map(file => [path.basename(file), fs.readFileSync(file, 'utf8')] as const);

    for (const [pkg, fingerprint] of CHART_FINGERPRINTS) {
      const onCriticalPath = scripts
        .filter(([, source]) => source.includes(fingerprint))
        .map(([name]) => name);

      expect(onCriticalPath, `every player downloads ${pkg} before the home screen paints`).toEqual([]);
    }
  });
});
