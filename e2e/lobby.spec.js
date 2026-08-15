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

/**
 * The rules choice (Modernized | Classic) changes gameplay fundamentally, so
 * the lobby offers it as its own always-visible row — never folded into the
 * collapsed advanced panel. These pin that visibility and that the choice is
 * part of the saved local config, like the deck above.
 */
test.describe('Lobby ruleset selector', () => {
  test('offers both rulesets without expanding anything, defaulting to Modernized', async ({ page }) => {
    await page.goto('/');

    // Deliberately no "Show Advanced Options" click first.
    await expect(page.getByLabel('Modernized', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Classic', { exact: true })).not.toBeChecked();
    await expect(page.getByText(/House rules:/)).toBeVisible();
  });

  test('switching to Classic explains the chain rule and survives a reload', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel('Classic', { exact: true }).click();
    await expect(page.getByLabel('Classic', { exact: true })).toBeChecked();
    await expect(page.getByText(/Official rules:/)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Classic', { exact: true })).toBeChecked();
  });
});

/**
 * The Random Order switch was a bare `<div onClick>`, and it is the only call
 * site of setRandomOrder — so a keyboard-only host had no keystroke at all
 * that could change the play order (WCAG 2.1.1 Level A). The unit test focuses
 * it directly, which cannot prove the browser's own sequential navigation ever
 * REACHES it; that is what this adds. A `<div>` without tabIndex is skipped by
 * Tab entirely, so this is the assertion the original markup fails.
 */
test.describe('Lobby Random Order switch is operable without a mouse', () => {
  test('Tab reaches it and Space toggles it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Show Advanced Options/i }).click();

    const toggle = page.getByRole('switch', { name: /Random Order/i });
    await expect(toggle).toBeVisible();
    const before = await toggle.getAttribute('aria-checked');

    // Walk the real tab order from the top of the document rather than
    // focusing the switch directly — reachability is the whole point.
    await page.evaluate(() => document.body.focus());
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await toggle.evaluate(el => el === document.activeElement);
    }
    expect(reached, 'Tab never reached the Random Order switch').toBe(true);

    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  });
});
