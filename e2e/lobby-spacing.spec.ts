import { test, expect, type Locator, type Page } from '@playwright/test';
import { joinOnlineRoomPair } from './helpers';

const MOBILE_GAP_PX = 8;
const PIXEL_TOLERANCE = 1;
const PHONE_HEIGHT = 812;
const PHONE_WIDTHS = [320, 375];
const STANDARD_PHONE_WIDTH = 375;

async function expectGap(before: Locator, after: Locator) {
  await expect.poll(async () => {
    const first = await before.boundingBox();
    const second = await after.boundingBox();
    if (!first || !second) return Infinity;
    return Math.abs(second.y - first.y - first.height - MOBILE_GAP_PX);
  }).toBeLessThanOrEqual(PIXEL_TOLERANCE);
}

async function expectLobbySettings(page: Page, rules: Locator) {
  const table = page.locator('.player-name').first().locator('..').locator('..').locator('..');
  const options = page.getByRole('button', { name: 'Show Advanced Options' }).locator('..');
  await expectGap(table, rules);
  await expectGap(rules, options);
  const cards = options.locator(':scope > :visible');
  const count = await cards.count();
  for (let index = 0; index < count; index++) {
    const card = cards.nth(index);
    await expect.poll(async () => {
      const reference = await rules.boundingBox();
      const current = await card.boundingBox();
      if (!reference || !current) return Infinity;
      return Math.max(Math.abs(reference.x - current.x), Math.abs(reference.width - current.width));
    }).toBeLessThanOrEqual(PIXEL_TOLERANCE);
    if (index > 0) await expectGap(cards.nth(index - 1), card);
  }
}

test.describe('mobile lobby spacing', () => {
  // Include the phone-only setting in all engines, even desktop Firefox's
  // environment without the Vibration API. No hardware vibration is invoked.
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'vibrate', { value: () => true, configurable: true });
    });
  });

  for (const width of PHONE_WIDTHS) {
    test(`local sections and side gutters use the settings gap at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: PHONE_HEIGHT });
      await page.goto('/');
      const input = page.getByPlaceholder(/Player name/i);
      const bots = page.getByText('Add a bot', { exact: true }).locator('..');
      const rules = page.getByRole('group', { name: 'Rules', exact: true }).locator('..');
      await expectGap(bots, rules);
      await input.fill('Alice');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      const form = input.locator('..');
      const table = page.locator('.player-name').first().locator('..').locator('..').locator('..');
      await expectGap(form, bots);
      await expectGap(bots, table);
      await expectLobbySettings(page, rules);

      const panel = rules.locator('..').locator('..');
      for (const shell of [panel, panel.locator('..'), panel.locator('..').locator('..')]) {
        await expect.poll(() => shell.evaluate(element => {
          const style = getComputedStyle(element);
          return [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)];
        })).toEqual([MOBILE_GAP_PX, MOBILE_GAP_PX]);
      }
      // A flex input's intrinsic minimum width used to push Add outside its row.
      await expect.poll(() => form.evaluate(element => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(PIXEL_TOLERANCE);

      const toggle = page.getByRole('button', { name: /Advanced Options/ });
      const options = toggle.locator('..');
      const start = page.getByRole('button', { name: 'Need at least 2 players' }).locator('..');
      await expectGap(options, start);
      await toggle.click();
      const advanced = page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
      await expectGap(options, advanced);
      await expectGap(advanced, start);
    });
  }

  test('online host and guest share the same table, rules and setting gaps', async ({ browser }, testInfo) => {
    const contextOptions = { viewport: { width: STANDARD_PHONE_WIDTH, height: PHONE_HEIGHT } };
    const hostContext = await browser.newContext(contextOptions);
    const guestContext = await browser.newContext(contextOptions);
    try {
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();
      const roomId = `spacing-${testInfo.project.name}-${testInfo.workerIndex}`;
      await joinOnlineRoomPair({ page: host, name: 'Alice' }, { page: guest, name: 'Bob' }, roomId);
      await expect(guest.getByText('Waiting for host to start the game…')).toBeVisible();
      await expect(host.locator('.player-name')).toHaveCount(2);
      await expectLobbySettings(host, host.getByRole('group', { name: 'Rules', exact: true }).locator('..'));
      await expectLobbySettings(guest, guest.getByText(/^Rules: .*\(set by host\)$/));
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
