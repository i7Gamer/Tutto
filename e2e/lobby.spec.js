import { test, expect } from '@playwright/test';

/**
 * The deck editor puts a card's name and its count on one line, and the name
 * is set to ellipsis rather than wrap. That makes the column width a hard
 * constraint: two columns on a phone is narrow enough to cut the longer names
 * ("Plus/Minus", "Kleeblatt") off mid-word, so it stays at one until there is
 * room for more.
 *
 * Column counts alone would not have caught that — the cut-off is what the
 * player actually sees, so that is what these measure.
 */
test.describe('Lobby deck composition', () => {
  const PHONE_VIEWPORT = { width: 375, height: 900 };
  // Past Tailwind's `sm` breakpoint, where the markup asks for three columns.
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

  // A name set to ellipsis overflows its box before it is clipped, so the
  // element is wider than the space it is given. The pixel of slack keeps
  // sub-pixel layout rounding from reading as a cut-off name.
  const truncatedNames = grid =>
    grid.locator('label > span').evaluateAll(nodes => nodes
      .filter(node => node.scrollWidth > node.clientWidth + 1)
      .map(node => node.textContent.trim()));

  test('shows every card name in full on a phone', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    const grid = await openDeckEditor(page);

    expect(await truncatedNames(grid)).toEqual([]);
  });

  test('gives a phone one column, since two cannot hold the names', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    const grid = await openDeckEditor(page);

    expect(await gridColumns(grid)).toBe(1);
  });

  test('keeps the gap the markup asks for', async ({ page }) => {
    // A stray `.grid-cols-2` in index.css used to override the `gap-2` on the
    // element with a gap of its own, at 1rem.
    await page.setViewportSize(PHONE_VIEWPORT);
    const grid = await openDeckEditor(page);

    expect(await grid.evaluate(el => getComputedStyle(el).rowGap)).toBe('8px');
  });

  test('widens to three columns past the sm breakpoint', async ({ page }) => {
    await page.setViewportSize(TABLET_VIEWPORT);
    const grid = await openDeckEditor(page);

    expect(await gridColumns(grid)).toBe(3);
    expect(await truncatedNames(grid)).toEqual([]);
  });
});
