import { test, expect } from '@playwright/test';

/**
 * The wiki's table-of-contents pills live in a wrapping flex row that also
 * holds the "Table of Contents:" label. Flex items stretch to their own line's
 * height by default, and that label is taller than a pill — so the pills that
 * happened to share the label's line grew to match it while the ones that
 * wrapped onto the next line kept their natural height, and the same set of
 * buttons rendered at two different sizes.
 *
 * jsdom has no layout, so this is the only level at which the sizes can
 * actually be compared.
 */
test.describe('Wiki table of contents', () => {
  // Narrow enough that the seven pills cannot fit on one line — without a
  // wrap there is nothing to compare and the test would pass vacuously.
  const NARROW_VIEWPORT = { width: 380, height: 800 };

  test('renders every pill at the same height once they wrap onto a second row', async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    await page.goto('/');

    await page.getByTitle('Open Help / Wiki').click();

    const pills = page.getByTestId('help-toc-pill');
    await expect(pills.first()).toBeVisible();
    await expect(pills.last()).toBeVisible();

    const boxes = await pills.evaluateAll(nodes => nodes.map(node => {
      const { top, height } = node.getBoundingClientRect();
      return { top: Math.round(top), height: Math.round(height) };
    }));

    // Guards the guard: if they all sat on one row, equal heights would prove
    // nothing about the reported bug.
    expect(new Set(boxes.map(box => box.top)).size).toBeGreaterThan(1);
    expect(new Set(boxes.map(box => box.height)).size).toBe(1);
  });

  test('dresses the pills from the stylesheet', async ({ page }) => {
    // The pill look lives in HelpPopup.css rather than in a copy of the same
    // utility string on every button (src/components/HelpPopup.css). A
    // stylesheet that never reached the built app would leave bare buttons —
    // still all the same height, so the test above would not notice.
    await page.goto('/');

    await page.getByTitle('Open Help / Wiki').click();

    const pills = page.getByTestId('help-toc-pill');
    await expect(pills.first()).toBeVisible();

    const styles = await pills.evaluateAll(nodes => nodes.map(node => {
      const { borderTopLeftRadius, paddingLeft, backgroundColor } = getComputedStyle(node);
      return { borderTopLeftRadius, paddingLeft, backgroundColor };
    }));

    for (const style of styles) {
      expect(parseFloat(style.borderTopLeftRadius)).toBeGreaterThan(0);
      expect(parseFloat(style.paddingLeft)).toBeGreaterThan(0);
      expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    }

    // Selected and unselected pills stay distinguishable: exactly two looks.
    expect(new Set(styles.map(style => style.backgroundColor)).size).toBe(2);
  });
});
