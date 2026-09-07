import { test, expect } from '@playwright/test';
import { seedLocalDeck, startLocalGame, rollUntilSelectable } from './helpers';

test.describe('Tutto Local Game Flow', () => {
  test('should allow players to join and start a local game', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');
    
    // Ensure the app loaded and shows the mode selector
    await expect(page.getByRole('heading', { name: /Tutto/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Local Play/i })).toBeVisible();
    
    // By default it should be on local play, showing player input
    const playerInput = page.getByPlaceholder(/Player name/i);
    await expect(playerInput).toBeVisible();

    // Add Player 1: Alice
    await playerInput.fill('Alice');
    await page.getByRole('button', { name: /^Add$/i }).click();
    await expect(page.getByText('Alice', { exact: true }).first()).toBeVisible();

    // Add Player 2: Bob
    await playerInput.fill('Bob');
    await page.getByRole('button', { name: /^Add$/i }).click();
    await expect(page.getByText('Bob', { exact: true }).first()).toBeVisible();

    // Start Game
    await page.getByRole('button', { name: /Start Game!/i }).click();

    // Verify game screen loads
    await expect(page.getByText(/Current Player/i)).toBeVisible();
    // Exact: the goal banner now also says "The round is played to the end",
    // so a /Round/i regex matches two elements and fails strict mode.
    await expect(page.getByText('Round', { exact: true })).toBeVisible();
    
    // Alice's turn should be active initially
    await expect(page.getByText('Alice', { exact: true }).first()).toBeVisible();
    
    // Ensure the game controls are visible (card display heading was removed during UI modernisation)
    await expect(page.getByRole('button', { name: /Undo/i })).toBeVisible();
  });

  /**
   * Two bots and nobody else: the game plays itself. Each bot's turn opens
   * the dice panel on its own, plays it through, and the activity log gets
   * the entry — so an entry for each of them is the whole feature working end
   * to end, on the real timers (roughly ten seconds a turn).
   */
  test('two bots play the game by themselves', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add bot: Carl' }).click();
    await page.getByRole('button', { name: 'Add bot: Rita' }).click();
    await expect(page.getByText('Bot', { exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Add bot: Carl' })).toBeDisabled();

    await page.getByRole('button', { name: /Start Game!/i }).click();
    await expect(page.getByText(/Current Player/i)).toBeVisible();
    // Nothing for a human to press on a bot's turn.
    await expect(page.getByRole('button', { name: /Roll Dice/i })).toHaveCount(0);

    const log = page.getByText('Activity Log').locator('..');
    const BOT_TURN_BUDGET_MS = 60_000;
    await expect(log.getByText(/^Carl /).first()).toBeVisible({ timeout: BOT_TURN_BUDGET_MS });
    await expect(log.getByText(/^Rita /).first()).toBeVisible({ timeout: BOT_TURN_BUDGET_MS });
  });

  test('should persist local players after page reload', async ({ page }) => {
    await page.goto('/');
    const playerInput = page.getByPlaceholder(/Player name/i);
    await playerInput.fill('Charlie');
    await page.getByRole('button', { name: /^Add$/i }).click();
    await expect(page.getByText('Charlie', { exact: true }).first()).toBeVisible();

    await page.reload();

    // Verify player is still there (testing the init storage wipe bug)
    await expect(page.getByText('Charlie', { exact: true }).first()).toBeVisible();
  });
});

/**
 * Finding 39 — Game.tsx's two entrance columns (CardDisplay, GameControls)
 * animate in from x: -20 / x: 20 with nothing clipping that transient
 * horizontal excursion: at 375px wide, document.documentElement.scrollWidth
 * briefly overshot the viewport for as long as the tween ran, jiggling in a
 * horizontal scrollbar on phones. The grid wrapping both columns now carries
 * `overflow-x-clip`, which absorbs exactly that without removing the
 * animation and without affecting anything that legitimately overflows
 * vertically — the dice panel is a `fixed` ModalShell rendered as this
 * grid's own sibling, so it sits outside it entirely.
 */
test.describe('Game entrance animation stays within the viewport at 375px (finding 39)', () => {
  test('scrollWidth never exceeds the viewport while the columns slide in', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const playerInput = page.getByPlaceholder(/Player name/i);
    await playerInput.fill('Alice');
    await page.getByRole('button', { name: /^Add$/i }).click();
    await expect(page.getByText('Alice', { exact: true }).first()).toBeVisible();
    await playerInput.fill('Bob');
    await page.getByRole('button', { name: /^Add$/i }).click();
    await expect(page.getByText('Bob', { exact: true }).first()).toBeVisible();

    // Started before, and raced against, the click that mounts Game and
    // triggers the tween — the overflow this guards is transient, so
    // sampling only after the screen settles would pass whether or not the
    // fix is in place.
    const pollScrollWidth = page.evaluate(() => new Promise<number>(resolve => {
      const samples: number[] = [];
      const deadline = performance.now() + 600;
      const tick = () => {
        samples.push(document.documentElement.scrollWidth);
        if (performance.now() < deadline) requestAnimationFrame(tick);
        else resolve(Math.max(...samples));
      };
      requestAnimationFrame(tick);
    }));

    const [maxScrollWidth] = await Promise.all([
      pollScrollWidth,
      page.getByRole('button', { name: /Start Game!/i }).click(),
    ]);

    expect(maxScrollWidth).toBeLessThanOrEqual(375);
  });
});

/**
 * Proves the wiring and the locale, not the semantics: the exact count and
 * value per card are covered by rollAnnouncement.test.ts's unit tests, and
 * the regex below is deliberately loose so nobody "strengthens" it into a
 * duplicate semantic oracle here. seedLocalDeck's ROLLING_DECK guarantees an
 * ordinary bonus card (never Kniffel/Plus-Minus, whose wording differs), so
 * the "scoring dice" branch of the message is the one on screen.
 */
test.describe('screen-reader roll narration', () => {
  test('announces the landed roll through its own live region', async ({ page }) => {
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);

    // rollUntilSelectable already waits out the one-in-forty opening bust,
    // so by the time "Select all" is on screen the roll has settled and the
    // announcement has fired.
    await rollUntilSelectable(page);

    // formatList speaks the values as an English list ("1, 2, 3, 4, 5, and 6";
    // "1 and 2" for two dice), so the pattern allows the conjunction.
    const announcer = page.getByRole('status', { name: /Roll results/i });
    await expect.poll(() => announcer.textContent()).toMatch(
      /^Rolled [1-6](, [1-6])*(,? and [1-6])?\. [0-6] (scoring dice|dice count)/,
    );
  });
});

/**
 * "Ask Otto" is off by default (feature_plan_coach_install_narration.md,
 * Feature B) — the toggle itself and its reload survival are e2e/lobby.spec.ts's
 * job. This proves the wiring into a real turn: with the setting on, Otto's
 * advice appears under the roll board after the opening roll settles; with
 * it off, the line never appears at all.
 */
test.describe('Coach hint (Ask Otto)', () => {
  test('shows Otto\'s advice once the lobby toggle is on', async ({ page }) => {
    await seedLocalDeck(page);
    await page.goto('/');
    await page.getByLabel('Ask Otto On', { exact: true }).click();
    await startLocalGame(page);

    await rollUntilSelectable(page);
    await expect(page.getByText(/Otto would keep/)).toBeVisible();
  });

  test('shows nothing while the toggle is off, the default', async ({ page }) => {
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);

    await rollUntilSelectable(page);
    await expect(page.getByText(/Otto would keep/)).not.toBeVisible();
  });
});
