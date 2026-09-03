import { test, expect } from '@playwright/test';

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
    await page.getByRole('button', { name: /Add/i }).click();
    await expect(page.getByText('Alice', { exact: true }).first()).toBeVisible();

    // Add Player 2: Bob
    await playerInput.fill('Bob');
    await page.getByRole('button', { name: /Add/i }).click();
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

  test('should persist local players after page reload', async ({ page }) => {
    await page.goto('/');
    const playerInput = page.getByPlaceholder(/Player name/i);
    await playerInput.fill('Charlie');
    await page.getByRole('button', { name: /Add/i }).click();
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
    await page.getByRole('button', { name: /Add/i }).click();
    await expect(page.getByText('Alice', { exact: true }).first()).toBeVisible();
    await playerInput.fill('Bob');
    await page.getByRole('button', { name: /Add/i }).click();
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
