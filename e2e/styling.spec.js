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

/**
 * index.css reads two colours out of Tailwind's theme rather than copying them
 * (`--primary: var(--color-indigo-600)`), which keeps them from drifting the way
 * they did across the v4 upgrade. The catch is that a theme variable is only
 * emitted when something references that palette entry — drop the last
 * `bg-indigo-600` from the app and `--color-indigo-600` stops existing, taking
 * `--primary` with it. An unresolvable var() in a custom property computes to
 * the guaranteed-invalid value, which reads back as the empty string, so nothing
 * throws and nothing logs: the focus ring and the checked checkbox just lose
 * their colour.
 */
test.describe('theme colours resolve', () => {
  const SEMANTIC = ['--primary', '--secondary', '--border-color', '--bg-color', '--text-color'];

  for (const theme of ['light', 'dark']) {
    test(`every semantic colour has a value in ${theme} mode`, async ({ page }) => {
      await page.goto('/');

      const values = await page.evaluate((theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        const style = getComputedStyle(document.documentElement);
        return Object.fromEntries(
          ['--primary', '--secondary', '--border-color', '--bg-color', '--text-color']
            .map(name => [name, style.getPropertyValue(name).trim()])
        );
      }, theme);

      expect(SEMANTIC.filter(name => values[name] === '')).toEqual([]);
    });
  }
});
