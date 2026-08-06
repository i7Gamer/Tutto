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

const PRECACHE_URLS = MANIFEST.map(entry => new URL(entry.url, self.location.href).href);
const PRECACHED = new Set(PRECACHE_URLS);

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
    const names = await caches.keys();
    await Promise.all(names.filter(name => name !== PRECACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

/** Rejects rather than hanging, so a dead connection falls back promptly. */
const fetchWithTimeout = (request, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('network timeout')), timeoutMs);
  fetch(request).then(
    response => { clearTimeout(timer); resolve(response); },
    error => { clearTimeout(timer); reject(error); },
  );
});

/**
 * Network first, so a new deploy reaches a client on its next launch instead of
 * being shadowed by a stale shell. The cached copy is what makes an offline
 * start — including one from an invite link — possible at all.
 *
 * Every navigation stores under the same SHELL_URL regardless of its query, so
 * `/?room=ABC` is served by the shell cached for `/`.
 */
const handleNavigation = async request => {
  try {
    const response = await fetchWithTimeout(request, NAVIGATION_NETWORK_TIMEOUT_MS);
    if (response && response.ok) {
      const cache = await caches.open(PRECACHE);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(SHELL_URL);
    if (cached) return cached;
    return Response.error();
  }
};

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Precached build output: served from cache, falling back to the network for
  // anything the install pass could not store. Everything else — the API, the
  // socket, fonts — is left entirely alone.
  const url = new URL(request.url);
  if (url.origin === self.location.origin && PRECACHED.has(url.href)) {
    event.respondWith((async () => {
      const cached = await caches.match(url.href);
      return cached ?? fetch(request);
    })());
  }
});
