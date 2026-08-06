/** @vitest-environment node */
/**
 * Asserts against the generated service worker rather than the config that
 * produced it: this is the one behaviour nothing else would notice going
 * missing, since it changes only what happens on a bad connection, and only for
 * URLs carrying a query string.
 *
 * ci.yml builds before it runs the suite, so dist/ is present there. Locally it
 * skips rather than forcing a build for every unrelated test run — `npm run
 * build` first if you want it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVICE_WORKER = path.resolve(__dirname, '..', '..', 'dist', 'sw.js');
const built = fs.existsSync(SERVICE_WORKER);

describe.skipIf(!built)('the generated service worker', () => {
  const source = (): string => fs.readFileSync(SERVICE_WORKER, 'utf8');

  it('can serve its cached shell to a URL carrying a query string', () => {
    // Cache entries are keyed by full URL, so an invite link (`/?room=ABC`,
    // see roomLink.ts) would otherwise never match the shell stored for `/` —
    // leaving the navigation most likely to arrive on a phone with a bad
    // connection as the one that cannot fall back to the cache. Verified in
    // Chromium: matching '/?room=X' against an entry stored for '/' misses by
    // default and hits with ignoreSearch.
    expect(source()).toMatch(/html-cache[^)]*ignoreSearch\s*:\s*(!0|true)/);
  });

  it('still reaches for the network first, so a new deploy is not served stale', () => {
    expect(source()).toMatch(/NetworkFirst\({cacheName:"html-cache"/);
  });
});
