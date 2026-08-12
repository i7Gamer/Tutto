/**
 * Hand-written service worker, used through vite-plugin-pwa's `injectManifest`
 * strategy rather than letting it generate one.
 *
 * Why not the generated worker: under this toolchain workbox's runtime does not
 * survive bundling. The generated sw.js wraps everything in an AMD-style
 * `define([...], factory)` that loads the runtime from a second chunk, and the
 * result registers, activates and claims clients — `clientsClaim()` runs — while
 * `precacheAndRoute()` quietly never installs anything. Measured: no precache
 * request is ever made and no cache is ever created, so nothing worked offline.
 * Inlining the runtime instead (`inlineWorkboxRuntime`) fails harder, with
 * "ServiceWorker script evaluation failed". Neither minification nor the
 * registration options are involved — both were ruled out by experiment.
 *
 * So this file owns the whole behaviour. It has no imports, which keeps the
 * bundling step close to an identity transform, and it is small enough to read
 * in one sitting.
 */

/** How long a navigation waits for the network before falling back to cache. */
const NAVIGATION_NETWORK_TIMEOUT_MS = 3000;

/** The document every navigation resolves to — this is a single-page app. */
const SHELL_URL = new URL('index.html', self.location.href).href;

// Injected at build time from the build output (see injectManifest in
// vite.config.js): [{ url, revision }, ...].
const MANIFEST = self.__WB_MANIFEST;

// De-duplicated: the build's glob picks up the icons and the webmanifest that
// vite-plugin-pwa also injects from its own `manifest` config, so those four
// arrive twice. install() fetches every entry, and the pair for a 138 KB icon
// is 138 KB of a phone's data spent for nothing on every deploy.
const PRECACHE_URLS = [...new Set(MANIFEST.map(entry => new URL(entry.url, self.location.href).href))];
const PRECACHED = new Set(PRECACHE_URLS);

/**
 * The directories the build emits hashed assets into, derived from the manifest
 * rather than hardcoded.
 *
 * A URL under one of these is build output by construction, which is what makes
 * it safe to answer from a cache generation other than this worker's own (see
 * the fetch handler). Root-level entries — index.html, the icons, the
 * webmanifest — yield "/" and are dropped: that prefix matches the API and the
 * socket too, and those must never be served from a cache.
 */
const ASSET_PREFIXES = [...new Set(
  PRECACHE_URLS.map(href => {
    const { pathname } = new URL(href);
    return pathname.slice(0, pathname.lastIndexOf('/') + 1);
  }),
)].filter(prefix => prefix !== '/');

const isBuildAsset = url => ASSET_PREFIXES.some(prefix => url.pathname.startsWith(prefix));

/**
 * How many cache generations survive an activate: this worker's own, plus the
 * one before it. skipWaiting/clients.claim below hand this worker control of
 * tabs still running the PREVIOUS build, whose lazy chunks are not in this
 * manifest — deleting their generation left those imports to a network that no
 * longer serves those hashed filenames.
 */
const RETAINED_CACHE_GENERATIONS = 2;

/**
 * Cache name derived from the manifest, so a deploy that changes any asset
 * lands in a fresh cache and `activate` can drop the previous one wholesale.
 * Cheap string hash — this only has to change when the contents do.
 */
const cacheName = () => {
  const fingerprint = MANIFEST.map(entry => `${entry.url}@${entry.revision ?? ''}`).join('|');
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i += 1) {
    hash = (Math.imul(hash, 31) + fingerprint.charCodeAt(i)) | 0;
  }
  return `tutto-precache-${(hash >>> 0).toString(36)}`;
};

const PRECACHE = cacheName();

// Registered at the top level, synchronously. This is the part the generated
// worker got wrong: a listener added after the script finishes evaluating
// misses its event, and Chrome decides a worker with no fetch listener at
// evaluation time cannot handle fetches at all.
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    // Individually rather than addAll, which rejects the whole install if any
    // single request fails — one missing asset should not cost offline support
    // entirely.
    await Promise.all(PRECACHE_URLS.map(async url => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response);
      } catch {
        // Leave it out; the runtime handler below still falls back to network.
      }
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // CacheStorage.keys() is ordered by creation, so the tail is the most
    // recent — everything older than the retained window goes.
    const names = await caches.keys();
    const previous = names.filter(name => name !== PRECACHE).slice(-(RETAINED_CACHE_GENERATIONS - 1));
    const keep = new Set([PRECACHE, ...previous]);
    await Promise.all(names.filter(name => !keep.has(name)).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

/**
 * The cached copy of a URL, preferring this worker's own generation.
 *
 * caches.match searches generations oldest-first, and the retained previous
 * cache (see RETAINED_CACHE_GENERATIONS) holds its own copy of every
 * same-URL-every-build file — index.html above all. A bare caches.match would
 * hand an offline start the PREVIOUS build's shell even though the current
 * one is fully cached. The old generation is only ever meant to answer for
 * URLs the current one doesn't know: the old build's hashed chunks.
 */
const matchPreferringCurrent = async url => {
  const current = await caches.open(PRECACHE);
  return await current.match(url) ?? await caches.match(url);
};

/**
 * Rejects rather than hanging, so a dead connection falls back promptly — and
 * abandons the request when it does. Rejecting alone only stopped WAITING for
 * it: the fetch stayed in flight on the same dead connection this exists to
 * route around, holding a socket and, on a metered phone connection, still
 * paying for a response nobody would read.
 */
const fetchWithTimeout = (request, timeoutMs) => {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('network timeout'));
    }, timeoutMs);
    fetch(request, { signal: controller.signal }).then(
      response => { clearTimeout(timer); resolve(response); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
};

/**
 * A navigation is fetched with redirect mode 'manual', so a 30x reaches the
 * worker as an opaque redirect: `type: 'opaqueredirect'`, `status: 0`,
 * `ok: false`. The browser follows it itself once it is handed back, and the
 * type is what says so — the status is 0 for a failed fetch too.
 *
 * Reading that "not ok" as a server error and answering index.html under the
 * ORIGINAL url instead breaks every deployment that redirects: auth gateways,
 * canonical-host redirects, trailing-slash normalisation.
 */
const OPAQUE_REDIRECT_TYPE = 'opaqueredirect';
const isOpaqueRedirect = response => response.type === OPAQUE_REDIRECT_TYPE;

/**
 * Network first, so a new deploy reaches a client on its next launch instead of
 * being shadowed by a stale shell. The cached copy is what makes an offline
 * start — including one from an invite link — possible at all.
 *
 * Every navigation stores under the same SHELL_URL regardless of its query, so
 * `/?room=ABC` is served by the shell cached for `/`.
 */
const handleNavigation = async request => {
  let response;
  try {
    response = await fetchWithTimeout(request, NAVIGATION_NETWORK_TIMEOUT_MS);
    if (response && response.ok) {
      const cache = await caches.open(PRECACHE);
      await cache.put(SHELL_URL, response.clone());
      return response;
    }
    // Not ok, but not ours to second-guess: a redirect the browser has to
    // follow goes straight back, uncached.
    if (response && isOpaqueRedirect(response)) return response;
  } catch {
    // Offline, refused, or the timeout above aborted it — same fallback as an
    // error status below.
  }
  // A server error is treated like a failed fetch. Behind the documented
  // reverse proxy a restarting container makes the proxy answer 502 promptly,
  // well inside the timeout, so it never reached the catch — and an installed
  // PWA showed the proxy's error page while a perfectly good shell sat in the
  // cache. The error response is still worth returning when there is nothing
  // cached to prefer over it.
  const cached = await matchPreferringCurrent(SHELL_URL);
  if (cached) return cached;
  return response ?? Response.error();
};

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Build output: served from cache, falling back to the network for anything
  // no cache holds. caches.match searches every retained generation, which is
  // what lets a tab still running the previous build load its own chunks (see
  // RETAINED_CACHE_GENERATIONS) — those are not in THIS manifest, so the
  // PRECACHED set alone would send them to a server that no longer has them.
  // Everything else — the API, the socket, fonts — is left entirely alone.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (PRECACHED.has(url.href) || isBuildAsset(url)) {
    event.respondWith((async () => {
      const cached = await matchPreferringCurrent(url.href);
      return cached ?? fetch(request);
    })());
  }
});
