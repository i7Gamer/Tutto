import { test, expect, devices, type Page } from '@playwright/test';

/**
 * The "Add to Home Screen" card on Home.tsx (src/components/InstallPrompt.tsx).
 * Not in offline.spec.ts: that file skips every non-Chromium engine at file
 * level (setOffline is Chromium/Firefox-only), and the iOS Safari variant
 * here needs the webkit legs specifically.
 *
 * None of this touches sw.js, the precache list, serviceWorkerConfig.test.ts,
 * bundleSplit.test.ts or dependencies.test.ts — lucide-react is already a
 * dependency and no package is added.
 */

const HAS_FINISHED_GAME_KEY = 'tutto_hasFinishedGame';
const INSTALL_PROMPT_DISMISSED_KEY = 'tutto_installPromptDismissed';
const FLAG_VALUE = 'true';

/**
 * Seeds "this device has already finished a game" before the app's first
 * script runs. Home reads localStorage during its very first render (through
 * useInstallPrompt's lazy useState init), so writing the flag after
 * navigation — a post-navigation `evaluate` — would always land one render
 * too late. Same technique as helpers.ts's seedLocalDeck.
 */
const seedFinishedGame = (page: Page) =>
  page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, value);
  }, { key: HAS_FINISHED_GAME_KEY, value: FLAG_VALUE });

type FakeOutcome = 'accepted' | 'dismissed';

/**
 * Dispatches a synthetic `beforeinstallprompt` event carrying the two members
 * useInstallPrompt.ts actually calls: `prompt()` and `userChoice`. The real
 * event only exists on Chromium, and Playwright cannot trigger the browser's
 * own install heuristics on demand, so this is the only way to exercise the
 * "native" branch at all.
 */
const dispatchFakeBeforeInstallPrompt = (page: Page, outcome: FakeOutcome = 'accepted') =>
  page.evaluate((outcome: FakeOutcome) => {
    class FakeBeforeInstallPromptEvent extends Event {
      userChoice: Promise<{ outcome: FakeOutcome }>;
      constructor(outcome: FakeOutcome) {
        super('beforeinstallprompt', { cancelable: true });
        this.userChoice = Promise.resolve({ outcome });
      }
      prompt() {
        return Promise.resolve();
      }
    }
    window.dispatchEvent(new FakeBeforeInstallPromptEvent(outcome));
  }, outcome);

const readFlag = (page: Page, key: string) => page.evaluate(key => localStorage.getItem(key), key);

test.describe('Install prompt — Chromium native flow', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'beforeinstallprompt only exists on Chromium');

  test('shows the card once offered, installs, and stays dismissed after a reload', async ({ page }) => {
    await seedFinishedGame(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tutto' })).toBeVisible();

    // No card before Chromium has actually offered to install.
    await expect(page.getByRole('region', { name: /Install this app/i })).not.toBeVisible();

    await dispatchFakeBeforeInstallPrompt(page, 'accepted');

    const card = page.getByRole('region', { name: /Install this app/i });
    await expect(card).toBeVisible();
    const installButton = page.getByRole('button', { name: /Install app/i });
    await expect(installButton).toBeVisible();

    await installButton.click();

    await expect(card).not.toBeVisible();
    expect(await readFlag(page, INSTALL_PROMPT_DISMISSED_KEY)).toBe(FLAG_VALUE);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Tutto' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Install this app/i })).not.toBeVisible();
  });
});

test.describe('Install prompt — iOS Safari instructions', () => {
  test.skip(({ browserName }) => browserName !== 'webkit', 'the iOS copy only applies to Mobile Safari');
  test.use({ userAgent: devices['iPhone 13'].userAgent });

  test('shows Share instructions instead of an Install button, and dismiss is permanent', async ({ page }) => {
    await seedFinishedGame(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tutto' })).toBeVisible();

    const card = page.getByRole('region', { name: /Install this app/i });
    await expect(card).toBeVisible();
    await expect(page.getByText(/Add to Home Screen/i)).toBeVisible();
    // The Chromium-only button never renders here — there is no
    // beforeinstallprompt event on Safari to call prompt() on.
    await expect(page.getByRole('button', { name: /Install app/i })).not.toBeVisible();

    await page.getByRole('button', { name: /Dismiss/i }).click();

    await expect(card).not.toBeVisible();
    expect(await readFlag(page, INSTALL_PROMPT_DISMISSED_KEY)).toBe(FLAG_VALUE);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Tutto' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Install this app/i })).not.toBeVisible();
  });
});

test.describe('Install prompt — everywhere else', () => {
  test.skip(({ browserName }) => browserName !== 'firefox', 'one engine is enough for the no-event/non-iOS case');

  test('never shows: no beforeinstallprompt event and not iOS Safari', async ({ page }) => {
    await seedFinishedGame(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tutto' })).toBeVisible();

    await expect(page.getByRole('region', { name: /Install this app/i })).not.toBeVisible();
  });
});
