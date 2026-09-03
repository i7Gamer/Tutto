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
// A real build, not the bare dist/index.html stub server/api.test.ts writes
// for its SPA-fallback probes: that stub used to read as "built" and fail the
// self-oracle below in any checkout without a build.
const built = fs.existsSync(INDEX_HTML) && fs.existsSync(path.join(DIST, 'assets'));

// A chart.js internal that survives minification and appears nowhere else.
const CHARTJS_FINGERPRINT = '_metasets';

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

  it('has the charting library somewhere in the build', () => {
    // The other half of the oracle: if chart.js were dropped entirely, the
    // check below would pass for the wrong reason.
    const carriers = fs.readdirSync(path.join(DIST, 'assets'))
      .filter(file => file.endsWith('.js'))
      .filter(file => fs.readFileSync(path.join(DIST, 'assets', file), 'utf8').includes(CHARTJS_FINGERPRINT));

    expect(carriers.length).toBeGreaterThan(0);
  });

  it('does not put it in anything the first paint waits for', () => {
    const onCriticalPath = criticalPathScripts()
      .filter(file => fs.readFileSync(file, 'utf8').includes(CHARTJS_FINGERPRINT))
      .map(file => path.basename(file));

    expect(onCriticalPath, 'every player downloads a charting library before the home screen paints').toEqual([]);
  });
});
