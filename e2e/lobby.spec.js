import { test, expect } from '@playwright/test';

/**
 * index.css defined a `.grid-cols-2` of its own, which collided with the
 * Tailwind utility of that name: it came later in the bundle, so it won, and
 * its `max-width: 768px` rule forced a single column — beating the
 * `sm:grid-cols-3` the markup asks for from 640px up. The deck editor was one
 * column between 640 and 768px, and its `gap-2` came out at 1rem.
 */
test.describe('Lobby deck composition', () => {
  // Below Tailwind's `sm` breakpoint, where the markup's plain `grid-cols-2`
  // has no responsive variant of its own to outrank the stray rule.
  const PHONE_VIEWPORT = { width: 500, height: 900 };
  // Past `sm` (640px) but still inside the stray media query's 768px.
  const TABLET_VIEWPORT = { width: 700, height: 900 };

  const openDeckEditor = async page => {
    await page.goto('/');
    await page.getByRole('button', { name: /Show Advanced Options/i }).click();
    const grid = page.getByTestId('deck-composition-grid');
    await expect(grid).toBeVisible();
    return grid;
  };

  const gridColumns = grid =>
    grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);

  test('lays the deck editor out in two columns on a phone', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    const grid = await openDeckEditor(page);

    expect(await gridColumns(grid)).toBe(2);
  });

  test('keeps the gap the markup asks for on a phone', async ({ page }) => {
    // The stray rule also carried `gap: 1rem`, overriding the `gap-2` (0.5rem)
    // on the element.
    await page.setViewportSize(PHONE_VIEWPORT);
    const grid = await openDeckEditor(page);

    expect(await grid.evaluate(el => getComputedStyle(el).columnGap)).toBe('8px');
  });

  test('widens to three columns past the sm breakpoint', async ({ page }) => {
    await page.setViewportSize(TABLET_VIEWPORT);
    const grid = await openDeckEditor(page);

    expect(await gridColumns(grid)).toBe(3);
  });
});
