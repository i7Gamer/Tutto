import { test, expect } from '@playwright/test';

/**
 * A direct visit to a path the app has no route for — a stale bookmark, a
 * shared link whose room already ended, a crawler guessing at URLs. The
 * server's SPA fallback (server/api.ts) still has to answer with the app
 * shell for these, exactly as it does for "/".
 *
 * This guards two things at once, both regressions the same change (making
 * `base` absolute, see vite.config.ts) could have caused: the shell still
 * has to load its assets correctly from a path other than "/" it was never
 * requested at, and — the sharper regression — the inline recovery script in
 * index.html must not mistake a perfectly normal navigation for a broken
 * deploy and trigger its cache-wipe-and-reload path (see the "Auto-reload"
 * console messages it logs before doing that).
 */
test.describe('SPA fallback for an unknown route', () => {
  test('renders the Home screen and never logs an Auto-reload recovery attempt', async ({ page }) => {
    const consoleMessages: string[] = [];
    page.on('console', msg => consoleMessages.push(msg.text()));

    await page.goto('/does/not/exist/route');

    await expect(page.getByRole('heading', { name: /Tutto/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Local Play/i })).toBeVisible();

    // The recovery script only ever fires from an error event, and any such
    // event would already have fired by the time the Home screen above
    // rendered — this wait is just headroom for a console message to land
    // after that assertion resolves.
    await page.waitForTimeout(2000);

    expect(consoleMessages.some(text => text.includes('Auto-reload'))).toBe(false);
  });
});
