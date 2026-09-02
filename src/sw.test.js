/**
 * The hand-written service worker (src/sw.js).
 *
 * It runs in a worker global that jsdom does not provide, so the harness below
 * installs a `self`, a `caches` and a `fetch` before importing the module — the
 * module registers its listeners at import time (deliberately: see the comment
 * on the install handler), so they are captured as it evaluates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGIN = 'https://tutto.example';
const SHELL = `${ORIGIN}/index.html`;

const DEFAULT_MANIFEST = [
  { url: 'index.html', revision: 'r1' },
  { url: 'assets/index-aaa111.js', revision: null },
  { url: 'assets/index-aaa111.css', revision: null },
  { url: 'manifest.webmanifest', revision: 'r2' },
];

// A cache store backed by Maps, keyed in insertion order — the spec orders
// CacheStorage.keys() by creation, which the retention rule below relies on.
const makeCacheStorage = () => {
  const stores = new Map();
  const openStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    stores,
    open: async (name) => {
      const store = openStore(name);
      return {
        put: async (url, response) => { store.set(String(url), response); },
        match: async (url) => store.get(String(url)),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (url) => {
      for (const store of stores.values()) {
        const hit = store.get(String(url));
        if (hit) return hit;
      }
      return undefined;
    },
  };
};

const OK_STATUS = 200;
const BAD_GATEWAY_STATUS = 502;
/** What a 30x looks like to a worker: redirect mode 'manual' opacifies it. */
const OPAQUE_REDIRECT = { type: 'opaqueredirect', status: 0 };

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

// contentType defaults to the app shell's: every response these tests build
// stands in for a document unless it says otherwise, which is what the
// pre-existing navigation cases have always meant.
const makeResponse = (body, { ok = true, status = ok ? OK_STATUS : BAD_GATEWAY_STATUS, type = 'basic', contentType = HTML_CONTENT_TYPE } = {}) => ({
  ok,
  status,
  type,
  body,
  headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
  clone() { return makeResponse(body, { ok, status, type, contentType }); },
});

/** The browser follows this itself — the worker only has to hand it back. */
const makeOpaqueRedirect = () => makeResponse(null, { ok: false, ...OPAQUE_REDIRECT });

/** A fetch event whose respondWith/waitUntil promises the test can await. */
const makeEvent = (request) => {
  const event = { request, responses: [], waited: [] };
  event.respondWith = (p) => event.responses.push(p);
  event.waitUntil = (p) => event.waited.push(p);
  return event;
};

const makeRequest = (url, { mode = 'no-cors', method = 'GET' } = {}) => ({ url, mode, method });

let listeners;
let cacheStorage;
let fetchMock;

const loadSw = async ({ manifest = DEFAULT_MANIFEST } = {}) => {
  listeners = {};
  cacheStorage = makeCacheStorage();
  vi.stubGlobal('self', {
    __WB_MANIFEST: manifest,
    location: { href: `${ORIGIN}/index.html`, origin: ORIGIN },
    addEventListener: (type, handler) => { listeners[type] = handler; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
  });
  vi.stubGlobal('caches', cacheStorage);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Response', { error: () => makeResponse('network-error', { ok: false }) });
  vi.resetModules();
  await import('./sw.js');
};

/** Runs install and returns the name of the cache it filled. */
const runInstall = async () => {
  const event = makeEvent(null);
  listeners.install(event);
  await Promise.all(event.waited);
  const names = await cacheStorage.keys();
  return names[names.length - 1];
};

const runActivate = async () => {
  const event = makeEvent(null);
  listeners.activate(event);
  await Promise.all(event.waited);
};

const runFetch = async (request) => {
  const event = makeEvent(request);
  listeners.fetch(event);
  if (event.responses.length === 0) return { handled: false, response: undefined };
  const response = await event.responses[0];
  // The asset handler repairs a precache hole through waitUntil rather than
  // awaiting the write inside respondWith (see sw.js) — so the write is only
  // settled once these are, and a test that asserts on the cache must await
  // them or it races the repair.
  await Promise.all(event.waited);
  return { handled: true, response };
};

beforeEach(() => {
  fetchMock = vi.fn(async (input) => makeResponse(`network:${typeof input === 'string' ? input : input.url}`));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('service worker install', () => {
  it('precaches every manifest entry, resolved against the worker scope', async () => {
    await loadSw();
    const cacheName = await runInstall();

    const store = cacheStorage.stores.get(cacheName);
    expect([...store.keys()].sort()).toEqual([
      `${ORIGIN}/assets/index-aaa111.css`,
      `${ORIGIN}/assets/index-aaa111.js`,
      SHELL,
      `${ORIGIN}/manifest.webmanifest`,
    ]);
    // NOT skipWaiting: installing must not take control. See the message
    // handler's own tests below.
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  // The worker used to call skipWaiting() unconditionally in install, so a new
  // build took over the instant it finished installing — every open tab
  // reloaded at a moment nobody chose, mid-turn included, and a second reload
  // followed whenever the edge briefly served the previous sw.js again. The
  // page owns the decision now (src/utils/swUpdate.ts applies it only when a
  // reload would interrupt nothing).
  describe('taking over only when the page asks', () => {
    it('skips waiting when the page sends SKIP_WAITING', async () => {
      await loadSw();

      listeners.message({ data: { type: 'SKIP_WAITING' } });

      expect(self.skipWaiting).toHaveBeenCalled();
    });

    it('ignores any other message, and one with no data at all', async () => {
      await loadSw();

      listeners.message({ data: { type: 'SOMETHING_ELSE' } });
      listeners.message({ data: null });
      listeners.message({});

      expect(self.skipWaiting).not.toHaveBeenCalled();
    });

    it('keeps serving the running build until then', async () => {
      // The whole point: a worker that has installed but not been asked to
      // take over leaves the page it is running under alone.
      await loadSw();
      await runInstall();

      expect(self.skipWaiting).not.toHaveBeenCalled();
    });
  });

  it('fetches a URL the manifest lists twice only once', async () => {
    // The build's glob picks up the icons and the webmanifest that
    // vite-plugin-pwa also injects from its own `manifest` config, so the real
    // manifest carries four duplicates — and one of them is a 138 KB icon.
    // Fetching each pair twice spends a phone's data for nothing on every
    // deploy, since the second put just overwrites the first.
    await loadSw({
      manifest: [
        { url: 'index.html', revision: 'r1' },
        { url: 'assets/icon-512.png', revision: null },
        { url: 'assets/icon-512.png', revision: 'r3' },
      ],
    });
    const cacheName = await runInstall();

    const icon = `${ORIGIN}/assets/icon-512.png`;
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === icon)).toHaveLength(1);
    expect([...cacheStorage.stores.get(cacheName).keys()].sort()).toEqual([icon, SHELL]);
  });

  it('keeps the rest of the precache when one asset cannot be fetched', async () => {
    fetchMock = vi.fn(async (url) => (String(url).endsWith('.css')
      ? Promise.reject(new Error('offline'))
      : makeResponse('ok')));
    await loadSw();
    const cacheName = await runInstall();

    const store = cacheStorage.stores.get(cacheName);
    expect(store.has(`${ORIGIN}/assets/index-aaa111.css`)).toBe(false);
    expect(store.has(`${ORIGIN}/assets/index-aaa111.js`)).toBe(true);
  });

  it('names the cache after the manifest, so a changed asset lands in a fresh one', async () => {
    await loadSw();
    const first = await runInstall();

    await loadSw({ manifest: [{ url: 'assets/index-bbb222.js', revision: null }] });
    const second = await runInstall();

    expect(second).not.toBe(first);
  });

  // A7: reusing unchanged precache entries across generations. A hashed asset
  // (revision: null) has its content hash in the filename already, so an
  // identical URL in a retained previous generation is byte-identical content
  // — no need to spend a client's data re-downloading react, vendor, jsQR or
  // the icons on every deploy. Workbox does this; this worker didn't.
  describe('reusing entries from a retained previous generation', () => {
    it('copies an unchanged hashed asset from the previous generation instead of refetching it', async () => {
      await loadSw();
      const asset = `${ORIGIN}/assets/index-aaa111.js`;
      cacheStorage.stores.set('tutto-precache-previous', new Map([
        [asset, makeResponse('previous build js')],
      ]));

      const cacheName = await runInstall();

      expect(fetchMock.mock.calls.some(([u]) => u === asset)).toBe(false);
      const stored = await (await cacheStorage.open(cacheName)).match(asset);
      expect(stored.body).toBe('previous build js');
    });

    it('fetches a revision-less asset the previous generation does not have', async () => {
      await loadSw();
      // The previous generation exists, but never held this particular asset.
      cacheStorage.stores.set('tutto-precache-previous', new Map());

      const cacheName = await runInstall();

      const asset = `${ORIGIN}/assets/index-aaa111.js`;
      expect(fetchMock.mock.calls.some(([u]) => u === asset)).toBe(true);
      const stored = await (await cacheStorage.open(cacheName)).match(asset);
      expect(stored.body).toBe(`network:${asset}`);
    });

    it('still fetches a revisioned URL with cache: reload even when the previous generation has it', async () => {
      // index.html and the webmanifest change meaning without changing URL, so
      // their revision string is the only thing that says whether they're
      // stale — unlike a hashed asset, an identical URL is not proof of
      // identical content, so they must always be refetched from the network.
      await loadSw();
      cacheStorage.stores.set('tutto-precache-previous', new Map([
        [SHELL, makeResponse('previous shell')],
      ]));

      const cacheName = await runInstall();

      const call = fetchMock.mock.calls.find(([u]) => u === SHELL);
      expect(call, 'index.html must still be fetched').toBeDefined();
      expect(call[1]).toEqual({ cache: 'reload' });
      const stored = await (await cacheStorage.open(cacheName)).match(SHELL);
      expect(stored.body).toBe(`network:${SHELL}`);
    });

    it('fetches every entry when there is no previous generation to reuse from', async () => {
      await loadSw();

      await runInstall();

      const fetchedUrls = fetchMock.mock.calls.map(([u]) => u).sort();
      expect(fetchedUrls).toEqual([
        `${ORIGIN}/assets/index-aaa111.css`,
        `${ORIGIN}/assets/index-aaa111.js`,
        SHELL,
        `${ORIGIN}/manifest.webmanifest`,
      ]);
    });

    it('still resolves install when copying a previous-generation hit fails, fetching it from the network instead', async () => {
      // A single-entry manifest: install() runs PRECACHE_URLS concurrently
      // (Promise.all), and with more than one entry another URL's own
      // network-fetch put could race the copy-forward attempt below for the
      // "first put on this cache rejects" trick to target.
      await loadSw({ manifest: [{ url: 'assets/index-aaa111.js', revision: null }] });
      const asset = `${ORIGIN}/assets/index-aaa111.js`;
      cacheStorage.stores.set('tutto-precache-previous', new Map([
        [asset, makeResponse('previous build js')],
      ]));

      // The current generation's cache is the FIRST one install() opens
      // (see sw.js) — swap just that one open() call's `put` so its FIRST
      // write (the copy-forward attempt) rejects like a quota error, while
      // the network-fallback path's own put still lands for real, and every
      // other open() (reading the previous generation) is untouched.
      const realOpen = cacheStorage.open.bind(cacheStorage);
      let openCount = 0;
      cacheStorage.open = vi.fn(async (name) => {
        openCount += 1;
        const store = await realOpen(name);
        if (openCount !== 1) return store;
        let putCount = 0;
        return {
          ...store,
          put: async (...args) => {
            putCount += 1;
            if (putCount === 1) throw new Error('quota exceeded');
            return store.put(...args);
          },
        };
      });

      // A plain await, not expect().resolves: install() throwing (the bug)
      // must fail this test the same way any other unexpected rejection
      // would, with the real error surfaced instead of swallowed.
      const cacheName = await runInstall();

      expect(fetchMock.mock.calls.some(([u]) => u === asset), 'the failed copy must fall through to the network').toBe(true);
      const stored = await (await realOpen(cacheName)).match(asset);
      expect(stored.body).toBe(`network:${asset}`);
    });

    it('prefers a non-null revision over null for a URL the manifest lists twice, so a changed icon is not copied forward stale', async () => {
      // vite-plugin-pwa's glob picks the icon up with revision: null (its
      // hashless filename says nothing about content), then its manifest
      // injection lists the SAME URL again with a real hash — and the null
      // entry comes first, so a naive "keep the first occurrence" map would
      // treat the icon as immutable and copy it forward even when its bytes
      // changed.
      const icon = `${ORIGIN}/assets/icon-512.png`;
      const plainAsset = `${ORIGIN}/assets/index-aaa111.js`;
      await loadSw({
        manifest: [
          { url: 'assets/icon-512.png', revision: null },
          { url: 'assets/icon-512.png', revision: 'icon-hash' },
          { url: 'assets/index-aaa111.js', revision: null },
        ],
      });
      cacheStorage.stores.set('tutto-precache-previous', new Map([
        [icon, makeResponse('previous icon bytes')],
        [plainAsset, makeResponse('previous build js')],
      ]));

      const cacheName = await runInstall();

      const iconCall = fetchMock.mock.calls.find(([u]) => u === icon);
      expect(iconCall, 'the icon must be fetched, not copied forward, once a revision string is known for it').toBeDefined();
      expect(iconCall[1]).toEqual({ cache: 'reload' });

      // A plain revision-less URL is unaffected and still reused.
      expect(fetchMock.mock.calls.some(([u]) => u === plainAsset)).toBe(false);
      const storedAsset = await (await cacheStorage.open(cacheName)).match(plainAsset);
      expect(storedAsset.body).toBe('previous build js');
    });

    it('reuses an entry from a retained generation and still drops anything older on activate', async () => {
      await loadSw();
      const asset = `${ORIGIN}/assets/index-aaa111.js`;
      // Older than the retention window, and does not hold the asset either —
      // the search must fall through to the generation that does.
      cacheStorage.stores.set('tutto-precache-ancient', new Map());
      cacheStorage.stores.set('tutto-precache-previous', new Map([
        [asset, makeResponse('previous js')],
      ]));

      const current = await runInstall();
      expect(fetchMock.mock.calls.some(([u]) => u === asset)).toBe(false);

      await runActivate();

      const remaining = await cacheStorage.keys();
      expect(remaining).toContain(current);
      expect(remaining).toContain('tutto-precache-previous');
      expect(remaining).not.toContain('tutto-precache-ancient');
    });
  });
});

describe('service worker activate', () => {
  it('retains the previous cache generation so a claimed old tab keeps its chunks', async () => {
    // skipWaiting + clients.claim hand this worker control of tabs still
    // running the PREVIOUS build. Deleting every other cache took their
    // chunks with it, and the new worker does not serve URLs outside its own
    // manifest — so their lazy imports 404ed against a server that no longer
    // has those files.
    await loadSw();
    cacheStorage.stores.set('tutto-precache-ancient', new Map());
    cacheStorage.stores.set('tutto-precache-previous', new Map([
      [`${ORIGIN}/assets/index-old999.js`, makeResponse('old chunk')],
    ]));
    const current = await runInstall();

    await runActivate();

    const remaining = await cacheStorage.keys();
    expect(remaining).toContain(current);
    expect(remaining).toContain('tutto-precache-previous');
    expect(remaining).not.toContain('tutto-precache-ancient');
    expect(self.clients.claim).toHaveBeenCalled();
  });

  // caches.keys() answers for the whole ORIGIN, not just this worker. Anything
  // else that ever opened a cache here — an earlier worker generation under a
  // different naming scheme, a devtools experiment, another app on a shared
  // host — used to count as a retained generation, spending the single
  // retained slot on a cache whose contents this worker can never serve and
  // evicting the real previous build in the process.
  it('ignores caches that are not its own when picking what to retain', async () => {
    await loadSw();
    cacheStorage.stores.set('tutto-precache-previous', new Map([
      [`${ORIGIN}/assets/index-old999.js`, makeResponse('old chunk')],
    ]));
    // Created last, so insertion order puts it where the retained slice looks.
    cacheStorage.stores.set('some-other-apps-cache', new Map());
    const current = await runInstall();

    await runActivate();

    const remaining = await cacheStorage.keys();
    expect(remaining).toContain(current);
    expect(remaining, 'the real previous generation must survive').toContain('tutto-precache-previous');
    // A cache this worker did not create is not this worker's to delete
    // either — it belongs to whatever else is on the origin.
    expect(remaining).toContain('some-other-apps-cache');
  });

  it('serves a previous build asset out of the retained cache', async () => {
    await loadSw();
    cacheStorage.stores.set('tutto-precache-previous', new Map([
      [`${ORIGIN}/assets/index-old999.js`, makeResponse('old chunk')],
    ]));
    await runInstall();
    await runActivate();

    const { handled, response } = await runFetch(makeRequest(`${ORIGIN}/assets/index-old999.js`));

    expect(handled).toBe(true);
    expect(response.body).toBe('old chunk');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: `${ORIGIN}/assets/index-old999.js` }),
    );
  });

  it('goes to the network for an asset path no cache holds', async () => {
    await loadSw();
    await runInstall();
    await runActivate();

    const { handled, response } = await runFetch(makeRequest(`${ORIGIN}/assets/index-new777.js`));

    expect(handled).toBe(true);
    expect(response.body).toBe(`network:${ORIGIN}/assets/index-new777.js`);
  });

  it('repairs a precache hole left by a partially failed install', async () => {
    // install() deliberately tolerates a per-asset failure so one bad request
    // does not cost offline support entirely — but the runtime handler was
    // read-only, so the hole was PERMANENT: the cache name is a hash of the
    // manifest, so a hole still looks like a complete generation, and install
    // only re-runs when sw.js itself changes. A first visit on a flaky link
    // therefore left the entry bundle missing forever, and the next offline
    // start rendered an empty <div id="root">.
    const missing = `${ORIGIN}/assets/index-aaa111.js`;
    fetchMock = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === missing) throw new Error('flaky network');
      return makeResponse(`network:${url}`);
    });
    await loadSw();
    const cacheKey = await runInstall();
    expect(await (await cacheStorage.open(cacheKey)).match(missing)).toBeUndefined();

    // Back online: the asset is fetched and must now be WRITTEN BACK.
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      return makeResponse(`network:${url}`);
    });
    const { handled, response } = await runFetch(makeRequest(missing));
    expect(handled).toBe(true);
    expect(response.body).toBe(`network:${missing}`);

    // The repair is what makes the NEXT offline start work.
    const stored = await (await cacheStorage.open(cacheKey)).match(missing);
    expect(stored, 'the recovered asset was not written back into the precache').toBeDefined();
  });

  it('still delivers the asset when the repair write itself fails', async () => {
    // The repair must never cost the delivery it rides on. Awaiting the put
    // inside respondWith would reject the whole response when the put rejects
    // — QuotaExceededError on a full device — failing an asset whose fetch had
    // actually succeeded, which is strictly worse than the hole being repaired.
    const missing = `${ORIGIN}/assets/index-aaa111.js`;
    fetchMock = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === missing) throw new Error('flaky network');
      return makeResponse(`network:${url}`);
    });
    await loadSw();
    await runInstall();

    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      return makeResponse(`network:${url}`);
    });
    // Every put now rejects, as a device out of storage would.
    const openSpy = vi.spyOn(cacheStorage, 'open').mockImplementation(async () => ({
      put: async () => { throw new Error('QuotaExceededError'); },
      match: async () => undefined,
    }));

    const { handled, response } = await runFetch(makeRequest(missing));

    expect(handled).toBe(true);
    expect(response.body, 'a failed cache write must not fail the response').toBe(`network:${missing}`);
    openSpy.mockRestore();
  });

  it('does not cache a failed response, nor an asset outside this build', async () => {
    // A 502 or an old build's chunk must not be written into the current
    // generation — that would turn a transient error into a cached one, and
    // pollute a generation whose name claims to describe this manifest.
    fetchMock = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('index-aaa111.js')) return makeResponse('gateway error', { ok: false });
      return makeResponse(`network:${url}`);
    });
    await loadSw();
    const cacheKey = await runInstall();
    const store = await cacheStorage.open(cacheKey);

    await runFetch(makeRequest(`${ORIGIN}/assets/index-aaa111.js`));
    expect(await store.match(`${ORIGIN}/assets/index-aaa111.js`)).toBeUndefined();

    await runFetch(makeRequest(`${ORIGIN}/assets/index-old999.js`));
    expect(await store.match(`${ORIGIN}/assets/index-old999.js`)).toBeUndefined();
  });
});

describe('service worker fetch', () => {
  it('serves a precached asset from the cache', async () => {
    await loadSw();
    await runInstall();

    const { handled, response } = await runFetch(makeRequest(`${ORIGIN}/assets/index-aaa111.js`));

    expect(handled).toBe(true);
    expect(response.body).toBe('network:https://tutto.example/assets/index-aaa111.js');
  });

  it('leaves the API alone entirely — no cache, no interception', async () => {
    // The cross-generation asset lookup must never widen into a cache-first
    // read of live data.
    await loadSw();
    await runInstall();
    await runActivate();

    expect((await runFetch(makeRequest(`${ORIGIN}/api/stats/global`))).handled).toBe(false);
    expect((await runFetch(makeRequest(`${ORIGIN}/socket.io/?EIO=4`))).handled).toBe(false);
  });

  it('ignores non-GET requests', async () => {
    await loadSw();
    await runInstall();

    const { handled } = await runFetch(
      makeRequest(`${ORIGIN}/api/log/client-error`, { method: 'POST' }),
    );

    expect(handled).toBe(false);
  });

  it('tries the network first for a navigation and refreshes the cached shell', async () => {
    await loadSw();
    const cacheName = await runInstall();
    fetchMock.mockResolvedValueOnce(makeResponse('fresh shell'));

    const { handled, response } = await runFetch(
      makeRequest(`${ORIGIN}/?room=ABC`, { mode: 'navigate' }),
    );

    expect(handled).toBe(true);
    expect(response.body).toBe('fresh shell');
    // Stored under the shell URL regardless of the query it was asked for.
    expect(cacheStorage.stores.get(cacheName).get(SHELL).body).toBe('fresh shell');
  });

  it('does not overwrite the app shell with a same-origin response that is not a document', async () => {
    // Every mode:'navigate' request reaches handleNavigation before the
    // origin/asset filtering below it, and the shell is whatever came back.
    // So opening /api/health — the endpoint the README documents — in the
    // browser that has Tutto installed replaced the cached shell with JSON,
    // and the next offline start rendered it. Same for /manifest.webmanifest,
    // /favicon.svg, or any /assets/... URL opened in a tab.
    await loadSw();
    const cacheName = await runInstall();
    fetchMock.mockResolvedValueOnce(makeResponse('{"status":"ok"}', { contentType: 'application/json' }));

    const { response } = await runFetch(
      makeRequest(`${ORIGIN}/api/health`, { mode: 'navigate' }),
    );

    expect(response.body, 'the caller still gets what it asked for').toBe('{"status":"ok"}');
    expect(cacheStorage.stores.get(cacheName).get(SHELL).body, 'the shell is untouched').toBe('network:https://tutto.example/index.html');
  });

  it('still delivers the fresh shell when the cache write fails', async () => {
    // The asset branch was hardened against exactly this; the navigation
    // branch was not. Awaiting the put inside the try means a rejecting write
    // — QuotaExceededError on a full device — falls through to the cached
    // shell, so a phone with no storage left serves the OLD build on every
    // start while perfectly online, and never self-heals.
    await loadSw();
    await runInstall();
    fetchMock.mockResolvedValueOnce(makeResponse('newer build'));
    const openSpy = vi.spyOn(cacheStorage, 'open').mockImplementation(async () => ({
      put: async () => { throw new Error('QuotaExceededError'); },
      match: async () => makeResponse('older build'),
    }));

    const { response } = await runFetch(
      makeRequest(`${ORIGIN}/`, { mode: 'navigate' }),
    );

    expect(response.body, 'a failed cache write must not cost the fresh shell').toBe('newer build');
    openSpy.mockRestore();
  });

  it('falls back to the cached shell when the network fails', async () => {
    await loadSw();
    await runInstall();
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const { response } = await runFetch(
      makeRequest(`${ORIGIN}/?room=ABC`, { mode: 'navigate' }),
    );

    expect(response.body).toBe('network:https://tutto.example/index.html');
  });

  it('falls back to the cached shell when the server answers with an error', async () => {
    // Behind the documented reverse proxy, a restarting Node container makes
    // the proxy answer 502 well inside the network timeout — so this never
    // reaches the offline path, and the installed PWA showed the proxy's error
    // page instead of the app it already has cached.
    await loadSw();
    await runInstall();
    fetchMock.mockResolvedValueOnce(makeResponse('proxy 502', { ok: false }));

    const { response } = await runFetch(
      makeRequest(`${ORIGIN}/?room=ABC`, { mode: 'navigate' }),
    );

    expect(response.body).toBe('network:https://tutto.example/index.html');
  });

  it('hands an opaque redirect back untouched instead of serving the shell', async () => {
    // A navigation is fetched with redirect mode 'manual', so a 30x surfaces
    // here as an opaqueredirect — status 0, ok false — that the browser follows
    // itself. Treating "not ok" as "server error" swallowed it and answered
    // index.html under the ORIGINAL url, breaking every deployment that
    // redirects: auth gateways, canonical host, trailing-slash normalisation.
    await loadSw();
    const cacheName = await runInstall();
    fetchMock.mockResolvedValueOnce(makeOpaqueRedirect());

    const { response } = await runFetch(
      makeRequest(`${ORIGIN}/?room=ABC`, { mode: 'navigate' }),
    );

    expect(response.type).toBe('opaqueredirect');
    // Not the cached shell, and the redirect did not replace it either.
    expect(response.body).toBeNull();
    expect(cacheStorage.stores.get(cacheName).get(SHELL).body)
      .toBe('network:https://tutto.example/index.html');
  });

  it('does not cache the server error it fell back from', async () => {
    await loadSw();
    const cacheName = await runInstall();
    fetchMock.mockResolvedValueOnce(makeResponse('proxy 502', { ok: false }));

    await runFetch(makeRequest(`${ORIGIN}/`, { mode: 'navigate' }));

    expect(cacheStorage.stores.get(cacheName).get(SHELL).body)
      .toBe('network:https://tutto.example/index.html');
  });

  it('returns the server error itself when no shell is cached', async () => {
    // Nothing better to offer, and the real status beats a synthetic network
    // error for anyone reading the browser's own diagnostics.
    await loadSw({ manifest: [{ url: 'assets/index-aaa111.js', revision: null }] });
    await runInstall();
    fetchMock.mockResolvedValueOnce(makeResponse('proxy 502', { ok: false }));

    const { response } = await runFetch(makeRequest(`${ORIGIN}/`, { mode: 'navigate' }));

    expect(response.body).toBe('proxy 502');
    expect(response.ok).toBe(false);
  });

  it('serves the CURRENT shell offline, not the retained previous generation', async () => {
    // index.html keeps the same URL every build, so it exists in the retained
    // old cache too — and caches.match searches generations oldest-first. The
    // fallback must prefer this worker's own cache, or an offline start boots
    // the previous build even though the current one is fully cached.
    await loadSw();
    cacheStorage.stores.set('tutto-precache-previous', new Map([
      [SHELL, makeResponse('previous build shell')],
    ]));
    await runInstall();
    await runActivate();
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    const { response } = await runFetch(
      makeRequest(`${ORIGIN}/`, { mode: 'navigate' }),
    );

    expect(response.body).toBe('network:https://tutto.example/index.html');
  });

  it('serves a same-URL precached asset from the current generation, not the old one', async () => {
    // Same trap for root-level precache entries (manifest.webmanifest, icons):
    // identical URL across builds, so the oldest cache used to win.
    await loadSw();
    cacheStorage.stores.set('tutto-precache-previous', new Map([
      [`${ORIGIN}/manifest.webmanifest`, makeResponse('previous manifest')],
    ]));
    await runInstall();
    await runActivate();

    const { response } = await runFetch(makeRequest(`${ORIGIN}/manifest.webmanifest`));

    expect(response.body).toBe('network:https://tutto.example/manifest.webmanifest');
  });

  it('aborts the navigation request it gave up on instead of leaving it running', async () => {
    // Without an AbortController the timeout only stopped WAITING: the request
    // stayed in flight, competing with the cached response for the same
    // dead connection this exists to route around.
    vi.useFakeTimers();
    await loadSw();
    await runInstall();

    let capturedSignal;
    fetchMock.mockImplementationOnce((_input, init) => {
      capturedSignal = init?.signal;
      return new Promise(() => {}); // never settles
    });

    const event = makeEvent(makeRequest(`${ORIGIN}/`, { mode: 'navigate' }));
    listeners.fetch(event);
    await vi.advanceTimersByTimeAsync(3000);
    await event.responses[0];

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(true);
  });
});
