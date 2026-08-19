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
        // Indexed by the camelCase JS name, exactly as the untyped version
        // did — getPropertyValue would want the kebab-case CSS name instead.
        const styles = getComputedStyle(host.firstElementChild as Element) as unknown as Record<string, string>;
        const value = styles[property];
        host.remove();
        return value;
      }, { html, property });

      expect(actual).toBe(expected);
    });
  }
});

/**
 * The same trap, caught on a real element rather than a probe: `.lobby-row`
 * sets background-color from OUTSIDE any layer, so it outranks `@layer
 * utilities` however specific the utility is — a `hover:bg-gray-50` on the row
 * itself silently never applied, and the Random Order switch had no hover cue
 * at all. The fix moves the hover into the same unlayered context
 * (`.lobby-row-hoverable:hover`, LobbyShared.css), which only a real browser
 * can confirm: the rule is present in the stylesheet either way, and jsdom
 * resolves neither layers nor :hover.
 */
test.describe('the lobby row hover cue survives the cascade', () => {
  test('hovering the Random Order switch actually changes its background', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Show Advanced Options/i }).click();

    const toggle = page.getByRole('switch', { name: /Random Order/i });
    await expect(toggle).toBeVisible();

    const background = () => toggle.evaluate(el => getComputedStyle(el).backgroundColor);

    // Park the pointer somewhere harmless first, so the "resting" reading is
    // genuinely un-hovered however the previous action left the mouse.
    await page.mouse.move(0, 0);
    const resting = await background();

    await toggle.hover();
    await expect.poll(background, {
      message: '.lobby-row-hoverable:hover lost to the unlayered .lobby-row background',
    }).not.toBe(resting);
  });
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

      // The list is passed in rather than closed over — page.evaluate runs in
      // the browser, so a second copy written inline here would silently stop
      // covering whatever SEMANTIC grew.
      const values = await page.evaluate(({ theme, names }) => {
        document.documentElement.setAttribute('data-theme', theme);
        const style = getComputedStyle(document.documentElement);
        return Object.fromEntries(names.map(name => [name, style.getPropertyValue(name).trim()]));
      }, { theme, names: SEMANTIC });

      expect(SEMANTIC.filter(name => values[name] === '')).toEqual([]);
    });
  }

  /**
   * The `dark:` variant and the `[data-theme="dark"]` rules above are two
   * different mechanisms — the first is a `@custom-variant` in index.css, the
   * second an ordinary selector — and only the second is covered by the tests
   * above. The variant replaced a `darkMode` array in the deleted JS config, and
   * getting it wrong compiles `dark:` back to `prefers-color-scheme`, which
   * fails only for a reader whose OS theme disagrees with the in-app toggle.
   */
  test('the dark: variant follows the attribute, not the OS', async ({ page }) => {
    await page.goto('/');

    const read = (theme: string) => page.evaluate((theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const probe = document.createElement('div');
      probe.className = 'bg-white dark:bg-slate-800';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    }, theme);

    const light = await read('light');
    const dark = await read('dark');

    expect(light).not.toBe(dark);
    expect(light).toBe('rgb(255, 255, 255)');
  });

  /**
   * A player's name is drawn in their own colour, fitted per theme because most
   * colours legible on the light card are illegible on the dark one and vice
   * versa. React sets both fitted values as custom properties and `.player-name`
   * in index.css picks between them, so the switch is pure CSS — which means the
   * unit suite can only assert that the two properties are set, never that the
   * right one wins. That half lives here.
   */
  test('a player name follows the theme through its two custom properties', async ({ page }) => {
    await page.goto('/');

    const read = (theme: string) => page.evaluate((theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      const probe = document.createElement('div');
      probe.className = 'player-name';
      // Stand-ins for what readableNameVars emits, distinct enough that a rule
      // reading the wrong one, or neither, is unmistakable.
      probe.style.setProperty('--player-name-light', 'rgb(1, 2, 3)');
      probe.style.setProperty('--player-name-dark', 'rgb(250, 251, 252)');
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, theme);

    expect(await read('light')).toBe('rgb(1, 2, 3)');
    expect(await read('dark')).toBe('rgb(250, 251, 252)');
  });

  /**
   * `.player-name` is unlayered, like every other class rule in index.css, so it
   * has to outrank a text-* utility landing on the same element — otherwise a
   * colour utility added to one of those four elements later would silently take
   * the fitted colour away and put an unreadable one back.
   */
  test('a player name outranks a colour utility on the same element', async ({ page }) => {
    await page.goto('/');

    const color = await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
      const probe = document.createElement('div');
      probe.className = 'player-name text-red-500';
      probe.style.setProperty('--player-name-light', 'rgb(1, 2, 3)');
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });

    expect(color).toBe('rgb(1, 2, 3)');
  });

  /**
   * A scroller that reaches its end hands the rest of the gesture to the page
   * behind it — scroll chaining — so scrolling to the bottom of the wiki carried
   * on into the app underneath. `overscroll-contain` stops the handoff.
   *
   * Asserted on the real element rather than an injected probe: the unit suites
   * already pin that each scroller carries the class, and what is left to prove
   * is the half jsdom cannot — that it resolves to `contain` in a browser rather
   * than being dropped by the cascade.
   *
   * Playwright's WebKit is NOT Safari, and this property is where that shows:
   * measured 2026-08-19, its `CSS.supports('overscroll-behavior-y','contain')`
   * is false and an inline declaration does not even take, while real iOS
   * Safari has supported it since 16.0 (caniuse) — which is the platform this
   * change is aimed at. So the containment half is skipped there rather than
   * passed vacuously, and the scroll-container half, which every engine can
   * answer, is asserted first and unconditionally.
   */
  test("the wiki's scroller contains its overscroll instead of chaining to the page", async ({ page }) => {
    await page.goto('/');
    await page.getByTitle('Open Help / Wiki').click();

    const scroller = page.locator('[role="dialog"] .overflow-y-auto').first();
    await expect(scroller).toBeVisible();

    const behaviour = await scroller.evaluate(node => ({
      overflowY: getComputedStyle(node).overflowY,
      containment: getComputedStyle(node).getPropertyValue('overscroll-behavior-y'),
      supported: typeof CSS !== 'undefined' && !!CSS.supports
        && CSS.supports('overscroll-behavior-y', 'contain'),
    }));

    // `overscroll-behavior` only applies to an actual scroll container, so a
    // rule that lost its overflow would make the containment inert while still
    // reading as set. Checked everywhere, before the skip below.
    expect(behaviour.overflowY).toBe('auto');

    test.skip(!behaviour.supported, 'this WebKit build does not implement overscroll-behavior; real iOS Safari 16+ does');
    expect(behaviour.containment).toBe('contain');
  });

  /**
   * Two controls float over every screen: the help button (bottom-left) and
   * the theme/language row (bottom-right). Game.tsx has always cleared them
   * with `pb-20`; Statistics and the end screen had only their own `py-8`, so
   * the last row of a table or a chart sat underneath them on a phone.
   *
   * Measured against the button's real box rather than asserting `80px`, so
   * this stays true if the button is ever resized — and it is jsdom-proof only
   * here: layout is the whole assertion.
   */
  test('the statistics page clears the floating controls at the bottom', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 700 });
    await page.goto('/');
    await page.getByRole('button', { name: 'View Statistics' }).click();

    const container = page.getByTestId('statistics-page');
    await expect(container).toBeVisible();

    const help = page.getByTitle('Open Help / Wiki');
    const helpBox = await help.boundingBox();
    const viewport = page.viewportSize()!;
    // How far up the screen the floating button reaches from the bottom edge.
    const occupied = viewport.height - helpBox!.y;

    const paddingBottom = await container.evaluate(node =>
      parseFloat(getComputedStyle(node).paddingBottom));

    // Guards the guard: a button that measured as taking no space at all would
    // make the comparison below pass for any padding, including none.
    expect(occupied).toBeGreaterThan(40);
    expect(paddingBottom).toBeGreaterThanOrEqual(occupied);
  });

  /**
   * The other `@custom-variant`, and the other half of what the deleted JS
   * config used to hold. The scoreboard reflows into a row on a sideways phone
   * (Scoreboard.tsx); a width breakpoint alone would also catch a portrait one,
   * which has the height to lay the tiles out normally.
   */
  test('the phone-landscape variant applies only lying down', async ({ page }) => {
    await page.goto('/');

    const widthAt = async (viewport: { width: number; height: number }) => {
      await page.setViewportSize(viewport);
      return page.evaluate(() => {
        const probe = document.createElement('div');
        probe.className = 'phone-landscape:min-w-[75px]';
        document.body.appendChild(probe);
        const value = getComputedStyle(probe).minWidth;
        probe.remove();
        return value;
      });
    };

    // Only the positive case has an exact value; unset min-width reads back as
    // `auto` or `0px` depending on the engine, so the others assert absence.
    expect(await widthAt({ width: 850, height: 420 })).toBe('75px');       // sideways phone
    expect(await widthAt({ width: 420, height: 850 })).not.toBe('75px');   // same phone, upright
    expect(await widthAt({ width: 1280, height: 800 })).not.toBe('75px');  // desktop
  });
});
