import { test, expect } from '@playwright/test';

test.describe('Tutto Local Game Flow', () => {
  test('should allow players to join and start a local game', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');
    
    // Ensure the app loaded and shows the mode selector
    await expect(page.getByRole('heading', { name: /Tutto/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Local Play/i })).toBeVisible();
    
    // By default it should be on local play, showing player input
    const playerInput = page.getByPlaceholder(/Name of new player/i);
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
    await expect(page.getByText(/Round/i)).toBeVisible();
    
    // Alice's turn should be active initially
    await expect(page.getByText('Alice', { exact: true }).first()).toBeVisible();
    
    // Ensure the card display area is visible
    await expect(page.getByRole('heading', { name: /Current Card/i })).toBeVisible();
  });

  test('should persist local players after page reload', async ({ page }) => {
    await page.goto('/');
    const playerInput = page.getByPlaceholder(/Name of new player/i);
    await playerInput.fill('Charlie');
    await page.getByRole('button', { name: /Add/i }).click();
    await expect(page.getByText('Charlie', { exact: true }).first()).toBeVisible();

    await page.reload();

    // Verify player is still there (testing the init storage wipe bug)
    await expect(page.getByText('Charlie', { exact: true }).first()).toBeVisible();
  });
});
