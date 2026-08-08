import { test, expect } from '@playwright/test';

/**
 * The service worker only exists in a built app, so nothing exercised it until
 * the suite moved off the dev server. What it protects is narrow but real: a
 * local game needs no server to play, only to load, so without a working worker
 * the app cannot be opened at all without a network — on a phone at a table,
 * that is the whole feature.
 *
 * This is also the only guard against the failure that shipped: a worker can
 * register, activate and claim clients while caching nothing whatsoever, and
 * the app looks perfectly healthy online the entire time.
 */
test.describe('Offline', () => {
  // setOffline is a Chromium/Firefox capability in Playwright and unsupported
  // in WebKit; the worker itself is not browser-specific, so covering it once
  // is enough.
  test.skip(({ browserName }) => browserName !== 'chromium', 'setOffline is not supported in WebKit');

  /**
   * Resolves once the shell is actually stored — not merely once the worker has
   * started caching. Precaching fetches every asset, so waiting for "any entry"
   * races the install and leaves the one file an offline start needs missing.
   */
  // expect.poll rather than page.waitForFunction: the check has to await the
  // Cache API, and waitForFunction treats the promise an async predicate
  // returns as its (always truthy) result — so it would report success
  // immediately and every test here would race the install.
  const waitForPrecache = async page => {
    await page.goto('/');
    await expect.poll(
      () => page.evaluate(async () => {
        const shell = new URL('index.html', location.href).href;
        // Both conditions matter, and they happen in that order: the shell is
        // written during install, but a navigation is only intercepted once the
        // worker has activated and taken control. Waiting on the cache alone
        // leaves a window where the file is there and nothing serves it.
        const cached = !!(await caches.match(shell));
        return cached && !!navigator.serviceWorker.controller;
      }),
      { timeout: 30000, message: 'service worker never precached the shell and took control' },
    ).toBe(true);
  };

  test('caches the build output rather than only claiming to', async ({ page }) => {
    await waitForPrecache(page);

    const cached = await page.evaluate(async () => {
      const name = (await caches.keys())[0];
      const keys = await (await caches.open(name)).keys();
      return keys.map(request => new URL(request.url).pathname);
    });

    // The shell is what an offline start serves; without it there is nothing
    // to boot from however many assets are stored.
    expect(cached.some(pathname => pathname.endsWith('index.html'))).toBe(true);
    expect(cached.filter(pathname => pathname.endsWith('.js')).length).toBeGreaterThan(0);
  });

  test('starts with no network and can play a local game', async ({ page, context }) => {
    // The turn below rolls dice, and whether a turn rolls at all depends on the
    // card drawn: a Stop card ends it immediately, with no Roll Dice button to
    // press. The default deck is 10 Stop cards in 56, so this test failed about
    // one run in six for a reason that has nothing to do with being offline.
    // Seeding the deck with cards that all play a normal turn removes the draw
    // from the equation — init() reads this key and keeps the fields it
    // recognises (see pickLocalGameState), so the rest of the state is untouched.
    const ROLLING_DECK = { '200': 5, '300': 5, '400': 5, '500': 5, '600': 5 };
    await page.addInitScript(deck => {
      localStorage.setItem('tutto_local_game', JSON.stringify({ initialCards: deck }));
    }, ROLLING_DECK);

    await waitForPrecache(page);
    await context.setOffline(true);

    // A cold start, not a tab that was already open: this is reloading, or
    // tapping the installed app's icon, with no connection.
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Local Play/i })).toBeVisible();

    const playerInput = page.getByPlaceholder(/Player name/i);
    await playerInput.fill('Alice');
    await page.getByRole('button', { name: /^Add$/i }).click();
    await playerInput.fill('Bob');
    await page.getByRole('button', { name: /^Add$/i }).click();
    await page.getByRole('button', { name: /Start Game!/i }).click();

    await expect(page.getByText(/Current Player/i)).toBeVisible();
    await page.getByRole('button', { name: /Roll Dice/i }).click();
    await expect(page.getByText(/Current Score/i)).toBeVisible();
  });

  test('opens an invite link with no network, room already filled in', async ({ page, context }) => {
    await waitForPrecache(page);
    await context.setOffline(true);

    // Every navigation is served by the one cached shell regardless of its
    // query string — an invite arriving on a phone with no signal is exactly
    // the navigation least able to reach the network.
    await page.goto('/?room=OFFLINEROOM');

    await expect(page.getByPlaceholder(/e\.g\. 1234/i)).toHaveValue('OFFLINEROOM');
  });
});
