import { test, expect } from '@playwright/test';

/**
 * Tailwind v4 emits its utilities inside a real `@layer utilities`. Unlayered
 * CSS beats every layer no matter how weak its selector, so the moment any of
 * the app's own rules sits outside a layer it silently outranks the utilities —
 * `* { margin: 0; padding: 0 }` in index.css alone was enough to kill every
 * `p-*` and `m-*` class in the app. Nothing else catches it: the build passes,
 * the rules are all still in the stylesheet, and jsdom does not resolve layers,
 * so the unit suite cannot see it either. It only exists as computed style in a
 * real browser against the real bundle, which is exactly what this file has.
 *
 * The expectations below are what Tailwind v3 actually produced, not what looks
 * tidy: with no layers in play, specificity decided. Utilities (0,1,0) beat the
 * element rules (0,0,1) and the `*` reset (0,0,0), and LOSE to the app's own
 * class rules, which match at equal specificity and are written after them.
 */
test.describe('stylesheet cascade', () => {
  // Probes are injected rather than looked for in the UI: this is about which
  // rule wins, and a real element would confound that with its own classes.
  const PROBES = [
    { html: '<div class="p-4"></div>', property: 'paddingTop', expected: '16px',
      what: 'a p-4 utility outranks the * reset' },
    { html: '<div class="mb-8"></div>', property: 'marginBottom', expected: '32px',
      what: 'an mb-8 utility outranks the * reset' },
    { html: '<h1 class="text-5xl"></h1>', property: 'fontSize', expected: '48px',
      what: 'a text-5xl utility outranks the h1 font-size' },
    { html: '<h1 class="mb-2"></h1>', property: 'marginBottom', expected: '8px',
      what: 'an mb-2 utility outranks the h1 margin-bottom' },
    { html: '<div class="modal-panel p-4"></div>', property: 'paddingTop', expected: '16px',
      what: 'a p-4 utility applies where the component class sets no padding' },
    { html: '<button class="theme-toggle p-4"></button>', property: 'paddingTop', expected: '8px',
      what: '.theme-toggle padding still wins over p-4, as it did in v3' },
    { html: '<div class="stat-grid-2 gap-8"></div>', property: 'gap', expected: '16px',
      what: '.stat-grid-2 gap still wins over gap-8, as it did in v3' },
  ];

  for (const { html, property, expected, what } of PROBES) {
    test(what, async ({ page }) => {
      await page.goto('/');

      const actual = await page.evaluate(({ html, property }) => {
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        const value = getComputedStyle(host.firstElementChild)[property];
        host.remove();
        return value;
      }, { html, property });

      expect(actual).toBe(expected);
    });
  }
});
