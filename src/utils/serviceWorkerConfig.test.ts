/** @vitest-environment node */
/**
 * Guards the shape of the generated service worker, which nothing else would
 * notice going wrong: a worker can register, activate and claim clients while
 * caching nothing at all, and the app looks perfectly healthy online the whole
 * time. That is exactly what shipped until src/sw.js replaced the generated one.
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

  it('carries the build output as a precache manifest', () => {
    // injectManifest replaces self.__WB_MANIFEST at build time. Left in place,
    // the worker throws on load; replaced with nothing, it caches nothing.
    expect(source()).not.toContain('__WB_MANIFEST');
    expect(source().match(/"revision":/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it('precaches the shell an offline start has to serve', () => {
    // Navigations fall back to this document when the network is gone; without
    // it in the manifest there is nothing to boot from.
    expect(source()).toContain('index.html');
  });

  it('is a flat script, not a deferred module factory', () => {
    // The failure this replaced: workbox's generated worker wrapped everything
    // in `define([...], factory)` loading its runtime from a second chunk, and
    // precaching then never installed. A listener registered after the script
    // finishes evaluating misses its event, and Chrome treats a worker with no
    // fetch listener at evaluation time as unable to handle fetches at all.
    expect(source()).not.toMatch(/define\(\[/);
    expect(source()).not.toContain('importScripts');
  });

  it('handles fetches and installs at all', () => {
    for (const event of ['install', 'activate', 'fetch']) {
      expect(source()).toContain(event);
    }
  });
});
