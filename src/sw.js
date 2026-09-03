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
// vite.config.ts): [{ url, revision }, ...].
const MANIFEST = self.__WB_MANIFEST;

// De-duplicated: the build's glob picks up the icons and the webmanifest that
// vite-plugin-pwa also injects from its own `manifest` config, so those four
// arrive twice. install() fetches every entry, and the pair for a 138 KB icon
// is 138 KB of a phone's data spent for nothing on every deploy.
const PRECACHE_URLS = [...new Set(MANIFEST.map(entry => new URL(entry.url, self.location.href).href))];
const PRECACHED = new Set(PRECACHE_URLS);

/**
 * Revision per precache URL, from the injected manifest: `null` for a hashed
 * asset (the content hash already lives in the filename, so an identical URL
 * is proof of identical content) and a revision string for anything whose URL
 * stays the same across builds (index.html, the webmanifest, the icons) —
 * there the URL alone says nothing about whether the content changed.
 *
 * The icons are listed twice: once from the build's glob, with `revision:
 * null` (that entry knows nothing about hashing), and again from
 * vite-plugin-pwa's own manifest injection, with a real hash — and the null
 * entry comes first. A plain "keep the first occurrence" merge would then
 * treat an icon as immutable and copy it forward across a deploy that
 * changed its bytes, so a non-null revision always wins over a null one for
 * the same URL regardless of which is seen first, matching the PRECACHE_URLS
 * dedupe above.
 */
const MANIFEST_REVISIONS = new Map();
for (const entry of MANIFEST) {
  const href = new URL(entry.url, self.location.href).href;
  const existingRevision = MANIFEST_REVISIONS.get(href);
  if (existingRevision === undefined || (existingRevision === null && entry.revision !== null)) {
    MANIFEST_REVISIONS.set(href, entry.revision);
  }
}

/**
 * The directories the build emits HASHED assets into, derived from the
 * manifest rather than hardcoded.
 *
 * A URL under one of these is build output by construction, which is what
 * makes it safe to answer from a cache generation other than this worker's
 * own (see the fetch handler) — a stale tab's old hashed chunk is simply not
 * in this manifest, so PRECACHED alone would send it to a server that no
 * longer has it. Only a `null`-revision href qualifies: its URL already
 * encodes its content, which is the guarantee that makes an old generation's
 * copy safe to serve as-is. index.html, the webmanifest and the icons keep
 * the same URL across builds even when their content changes (a real
 * revision string, not `null` — see MANIFEST_REVISIONS above), so their
 * directory buys none of that guarantee and is excluded here. Root-level
 * entries yield "/" and are dropped regardless: that prefix matches the API
 * and the socket too, and those must never be served from a cache.
 */
const ASSET_PREFIXES = [...new Set(
  PRECACHE_URLS
    .filter(href => MANIFEST_REVISIONS.get(href) === null)
    .map(href => {
      const { pathname } = new URL(href);
      return pathname.slice(0, pathname.lastIndexOf('/') + 1);
    }),
)].filter(prefix => prefix !== '/');

const isBuildAsset = url => ASSET_PREFIXES.some(prefix => url.pathname.startsWith(prefix));

/**
 * How many cache generations survive an activate: this worker's own, plus the
 * one before it. clients.claim below hands this worker control of tabs still
 * running the PREVIOUS build, whose lazy chunks are not in this manifest —
 * deleting their generation left those imports to a network that no longer
 * serves those hashed filenames. Still true now that activation waits for the
 * page's SKIP_WAITING: the tab that asks reloads onto this build, but any
 * OTHER open tab is claimed where it stands, still running the old one.
 */
const RETAINED_CACHE_GENERATIONS = 2;

/**
 * Cache name derived from the manifest, so a deploy that changes any asset
 * lands in a fresh cache and `activate` can drop the previous one wholesale.
 * Cheap string hash — this only has to change when the contents do.
 */
const CACHE_PREFIX = 'tutto-precache-';

const cacheName = () => {
  const fingerprint = MANIFEST.map(entry => `${entry.url}@${entry.revision ?? ''}`).join('|');
  let hash = 0;
  for (let i = 0; i < fingerprint.length; i += 1) {
    hash = (Math.imul(hash, 31) + fingerprint.charCodeAt(i)) | 0;
  }
  return `${CACHE_PREFIX}${(hash >>> 0).toString(36)}`;
};

const PRECACHE = cacheName();

// Registered at the top level, synchronously. This is the part the generated
// worker got wrong: a listener added after the script finishes evaluating
// misses its event, and Chrome decides a worker with no fetch listener at
// evaluation time cannot handle fetches at all.
self.addEventListener('install', event => {
  // NO skipWaiting() here. It used to be unconditional, which meant a new
  // worker took control the instant it finished installing — reloading every
  // open tab at a moment nobody chose, mid-turn included. The page decides
  // now, via the SKIP_WAITING message below.
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);

    // The generation(s) `activate` is about to retain (see
    // RETAINED_CACHE_GENERATIONS) may already hold byte-identical copies of
    // this build's hashed assets — reuse them instead of re-downloading react,
    // vendor and jsQR on every deploy. Not the icons: those keep the same URL
    // across builds regardless of content (see MANIFEST_REVISIONS above), so
    // they are never eligible for this copy-forward and always come from the
    // network below. Opened once, up front, rather than per-URL: `caches.open`
    // on the same name is cheap, but there is no reason to pay it
    // PRECACHE_URLS times over.
    const previousCaches = await Promise.all(
      (await caches.keys())
        .filter(name => name.startsWith(CACHE_PREFIX) && name !== PRECACHE)
        .map(name => caches.open(name)),
    );

    // Individually rather than addAll, which rejects the whole install if any
    // single request fails — one missing asset should not cost offline support
    // entirely.
    await Promise.all(PRECACHE_URLS.map(async url => {
      // Only a hashed asset (revision: null) is safe to copy forward: its URL
      // encodes its content, so a same-URL hit in a previous generation is
      // guaranteed identical. Anything with a revision string — index.html,
      // the manifest, the icons — keeps the same URL across builds even when
      // its content changes, so it must always come from the network.
      if (MANIFEST_REVISIONS.get(url) === null) {
        for (const previousCache of previousCaches) {
          const cached = await previousCache.match(url);
          if (cached) {
            try {
              await cache.put(url, cached);
              return;
            } catch {
              // Quota or similar — fall through to the network fetch below
              // rather than letting one failed copy reject the whole install.
              break;
            }
          }
        }
      }
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response);
      } catch {
        // Leave it out; the runtime handler below still falls back to network.
      }
    }));
  })());
});

/**
 * The page asking this worker to take over.
 *
 * Sent by workbox-window's messageSkipWaiting() when the app decides a reload
 * would interrupt nothing (src/utils/swUpdate.ts). Until it arrives, a newly
 * installed worker sits in `waiting` and the running build keeps serving —
 * and if the message never comes, the browser activates it on the next start
 * with no client to reload at all.
 */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // CacheStorage.keys() answers for the whole ORIGIN, so it can hand back
    // caches this worker never created (an older naming scheme, another app on
    // a shared host). Those are neither ours to delete nor eligible to fill a
    // retained slot: counting one spent the slot on a cache whose contents
    // this worker cannot serve and evicted the real previous build with it.
    const names = (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX));
    // Ordered by creation, so the tail is the most recent — everything older
    // than the retained window goes.
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
 * Whether a response is a document, and so a candidate for the app shell.
 *
 * Every mode 'navigate' request lands in handleNavigation — the origin and
 * asset filtering in the fetch handler sits BELOW that branch and never sees
 * one. So the shell used to be whatever a navigation last returned: opening
 * /api/health (the endpoint the README documents), /manifest.webmanifest,
 * /favicon.svg or a direct /assets/... URL in the browser that has Tutto
 * installed replaced the cached shell with that, and the next offline start —
 * or the 502-during-restart fallback this whole function exists for — rendered
 * it instead of the app.
 */
const isDocument = response =>
  (response.headers?.get('content-type') ?? '').toLowerCase().includes('text/html');

/**
 * Network first, so a new deploy reaches a client on its next launch instead of
 * being shadowed by a stale shell. The cached copy is what makes an offline
 * start — including one from an invite link — possible at all.
 *
 * Every navigation stores under the same SHELL_URL regardless of its query, so
 * `/?room=ABC` is served by the shell cached for `/`.
 */
const handleNavigation = async (event, request) => {
  let response;
  try {
    response = await fetchWithTimeout(request, NAVIGATION_NETWORK_TIMEOUT_MS);
    if (response && response.ok) {
      // Through waitUntil and swallowing its own failure, for the same reason
      // the asset branch below does it: awaiting the put here means a
      // rejecting write — QuotaExceededError on a device out of storage —
      // leaves the try, and the fallback then serves the CACHED shell over the
      // fresher one already in hand. A full phone would sit on an old build
      // every start while perfectly online, and never self-heal, because the
      // next generation's cache is created empty and the old shell keeps
      // matching. waitUntil still keeps the worker alive until the write lands.
      if (isDocument(response)) {
        const copy = response.clone();
        event.waitUntil(
          caches.open(PRECACHE)
            .then(cache => cache.put(SHELL_URL, copy))
            .catch(() => {}),
        );
      }
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
    event.respondWith(handleNavigation(event, request));
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
      if (cached) return cached;
      const response = await fetch(request);
      // Write back, or a precache hole is PERMANENT. `install` deliberately
      // tolerates a per-asset failure (one bad request should not cost offline
      // support entirely), but nothing else ever fills the gap: the cache name
      // is a hash of the manifest, so a hole still looks like a complete
      // generation, and install only re-runs when sw.js itself changes. A
      // first visit on a flaky link therefore lost an asset forever, and the
      // next offline start rendered an empty document.
      //
      // Only for THIS build's own precache entries: a successful response for
      // an old generation's chunk (isBuildAsset, served from the retained
      // cache) does not belong in a generation whose name claims to describe
      // this manifest, and a non-ok response must never be stored at all —
      // that would turn a transient 502 into a cached one.
      //
      // Through waitUntil, and swallowing its own failure, so the repair can
      // never cost the delivery it rides on: awaiting the write inside
      // respondWith would both delay the response and — if the put rejected,
      // which QuotaExceededError does on a full device — reject the whole
      // respondWith, failing an asset whose fetch had actually succeeded.
      // waitUntil still keeps the worker alive until the write lands. Same
      // reasoning as install's try/catch around its own put.
      if (response.ok && PRECACHED.has(url.href)) {
        const copy = response.clone();
        event.waitUntil(
          caches.open(PRECACHE)
            .then(cache => cache.put(url.href, copy))
            .catch(() => {}),
        );
      }
      return response;
    })());
  }
});
