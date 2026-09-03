import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { seedLocalDeck, startLocalGame, joinOnlineRoom } from './helpers';

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
  //
  // `contest` is the self-oracle for a "X still wins over U" claim, and it is
  // not optional pedantry: the gap probe below used to name `gap-8`, which
  // Tailwind never generated — @source covers src/, not e2e/, and the app's
  // only use of it is the responsive `sm:gap-8`. So the probe was reading
  // `.stat-grid-2` against NOTHING and passing on the strength of one rule
  // applying. `contest` measures the utility on its own first, which fails
  // loudly if it is absent from the stylesheet.
  //
  // `open` names a screen that has to be visited first. Statistics and the end
  // screen are lazy routes (App.tsx), so their CSS ships as its own stylesheet
  // and is injected only when the chunk loads. That makes the stat-grid probe
  // the more interesting one of the pair now: it proves an unlayered rule
  // still outranks `@layer utilities` when its stylesheet arrives LATE, which
  // is the cascade situation the lazy split introduced.
  interface Probe {
    html: string;
    property: string;
    expected: string;
    what: string;
    contest?: { html: string; expected: string };
    open?: 'statistics';
  }

  const PROBES: Probe[] = [
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
      contest: { html: '<button class="p-4"></button>', expected: '16px' },
      what: '.theme-toggle padding still wins over p-4, as it did in v3' },
    // gap-6 rather than gap-8: it is one the app actually uses, so Tailwind
    // emits it. .stat-grid-2 is gap-4 (16px), so the two genuinely disagree.
    { html: '<div class="stat-grid-2 gap-6"></div>', property: 'gap', expected: '16px',
      contest: { html: '<div class="gap-6"></div>', expected: '24px' },
      open: 'statistics',
      what: '.stat-grid-2 gap still wins over a gap utility, as it did in v3' },
  ];

  const computed = (page: Page, html: string, property: string) =>
    page.evaluate(({ html, property }) => {
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

  for (const { html, property, expected, what, contest, open } of PROBES) {
    test(what, async ({ page }) => {
      await page.goto('/');
      if (open === 'statistics') {
        await page.getByRole('button', { name: 'View Statistics' }).click();
        // Waited for, not assumed: the chunk's stylesheet is injected as part
        // of loading it, so probing before the screen is up would measure a
        // document that legitimately has no such rule yet.
        await expect(page.getByTestId('statistics-page')).toBeVisible();
      }

      if (contest) {
        expect(
          await computed(page, contest.html, property),
          'the utility this claims to outrank is not in the stylesheet at all',
        ).toBe(contest.expected);
      }

      expect(await computed(page, html, property)).toBe(expected);
    });
  }
});

/**
 * Finding 38 — the base `margin-bottom: 1rem` on h1-h4 (index.css) used to
 * apply unconditionally, including to a heading sharing a flex row with a
 * sibling control: the extra space below the heading's content grows its own
 * margin box, so `align-items: center` centres that taller box instead of the
 * text inside it, and the heading's visible content lands above the row's
 * true centre. index.css now excludes a heading that is itself a flex/grid
 * item from that rule (`:not(:where(.flex, .inline-flex, .grid, .inline-grid)
 * > *)`) — CurrentRollBoard's "Current Roll" h4, sharing a
 * `flex items-center justify-between` row with the "Select all" button, is
 * one of three sites this fixed (the other two are HelpPopup's dialog title,
 * centred against its close button, and OnlineLobby's "Recent Rooms"
 * heading). All three need a real browser to lay the row out and resolve
 * the `@layer`/`:where()` cascade — jsdom does neither — so this one probe
 * stands in for the shape of bug all three shared.
 */
test.describe('base heading margin does not leak into a flex row (finding 38)', () => {
  test('CurrentRollBoard\'s "Current Roll" heading has no bottom margin and centres with Select all', async ({ page }) => {
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);

    await page.getByRole('button', { name: /Roll Dice/i }).click();
    const heading = page.getByText('Current Roll', { exact: true });
    const selectAll = page.getByRole('button', { name: /Select all/i });
    await expect(selectAll).toBeVisible({ timeout: 15000 });
    await expect(heading).toBeVisible();

    expect(await heading.evaluate(el => getComputedStyle(el).marginBottom)).toBe('0px');

    const headingBox = await heading.boundingBox();
    const buttonBox = await selectAll.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();

    const headingCentre = headingBox!.y + headingBox!.height / 2;
    const buttonCentre = buttonBox!.y + buttonBox!.height / 2;
    // A leaked 1rem bottom margin used to push the heading's visible centre
    // roughly 8px above the button's — well outside this tolerance.
    expect(Math.abs(headingCentre - buttonCentre)).toBeLessThanOrEqual(2);
  });
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

  /**
   * The roster row (LobbyShared.tsx, PlayerList) paired `hover:bg-white` with
   * a plain (non-hover) `dark:bg-slate-800/50` — white-on-white made the light
   * hover invisible, and the unconditional dark rule gave no hover cue at all
   * in dark mode (it wins over the hover rule whether or not the row is
   * hovered). Fixed to `hover:bg-indigo-50 dark:hover:bg-slate-700/60`.
   *
   * Checked on another player's row in a real online lobby, not the local
   * one: LocalLobby has no concept of "other players" (`isMe` is
   * unconditionally true there), so every row already carries the always-on
   * own-row highlight — which differs from any hover colour regardless of
   * whether the hover utility does anything at all, masking exactly the bug
   * this guards. This is the case the custom no-conflicting-classnames lint
   * rule misses: it does not reason about a hover variant fighting an
   * unscoped dark variant on the same property.
   */
  test('hovering another player\'s roster row changes its background in both light and dark mode', async ({ browser }, testInfo: TestInfo) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    const roomId = `E2E-HOVER-${testInfo.project.name}-w${testInfo.workerIndex}-${Date.now()}`;
    await joinOnlineRoom(pageA, roomId, 'AliceHost');
    await expect(pageA.getByText('AliceHost').first()).toBeVisible({ timeout: 15000 });

    await joinOnlineRoom(pageB, roomId, 'BobGuest');
    await expect(pageA.getByText('BobGuest').first()).toBeVisible({ timeout: 15000 });

    // BobGuest's row, read from AliceHost's page: not "isMe", so it never
    // carries the own-row highlight.
    const row = pageA.locator('.player-name', { hasText: 'BobGuest' }).locator('xpath=..');
    const background = () => row.evaluate(el => getComputedStyle(el).backgroundColor);

    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark') {
        await pageA.getByLabel('Toggle theme').click();
      }
      // transition-colors animates the background over ~150ms — settle
      // before sampling, or a resting/hover pair caught mid-animation can
      // differ by residual interpolation alone and pass for the wrong reason.
      await pageA.mouse.move(0, 0);
      await pageA.waitForTimeout(300);
      const resting = await background();

      await row.hover();
      await expect.poll(background, {
        message: `BobGuest's roster row hover had no visible effect in ${theme} mode`,
      }).not.toBe(resting);

      await pageA.mouse.move(0, 0);
    }

    await contextA.close();
    await contextB.close();
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

/**
 * A8 — a contrast pass on a handful of accent/caption colours that shipped
 * below WCAG AA (4.5:1 for text, 3:1 for large text) once the v3->v4 palette
 * swap left several `text-*-500/600` utilities with no `dark:` twin, and a
 * couple of gray-on-white captions under 3:1 in light mode.
 *
 * The ratio itself is computed here rather than in a unit test: the app's own
 * contrastRatio (src/utils/contrastColor.ts) takes hex, but Tailwind v4's
 * palette is defined in oklch and only resolves to a concrete rgb() once a
 * real browser has laid the page out — exactly the case the task allowed
 * falling back to an e2e probe for. The algorithm below is the same WCAG 2.1
 * relative-luminance formula contrastColor.ts uses, reading getComputedStyle()
 * instead of a hex literal.
 */
test.describe('WCAG AA contrast — accent and caption fixes (A8)', () => {
  const AA_TEXT = 4.5;
  const AA_LARGE = 3;

  const contrastOf = (locator: Locator): Promise<number> => locator.evaluate((el) => {
    // getComputedStyle().color on a Tailwind v4 utility comes back as a raw
    // 'oklch(L C H)' (or 'oklab(L a b)' for a colourless mix like bg-black/5)
    // string in this Chromium build, not rgb()/rgba() — confirmed by probing
    // a real `text-indigo-600` node, and a canvas fillStyle round-trip does
    // NOT normalise it either (its getter echoes the oklch string back
    // unchanged). A plain rgba() regex over either therefore silently read
    // every colour as black-on-transparent and every ratio came back exactly
    // 1. This converts oklab/oklch to sRGB directly with the standard
    // OKLab<->linear-sRGB matrices (Björn Ottosson's oklab reference), the
    // same math every CSS-color-4-aware engine uses internally.
    const oklabToSrgb255 = (L: number, a: number, b: number): [number, number, number] => {
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
      const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
      const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
      const gamma = (c: number) => {
        const clamped = Math.max(0, Math.min(1, c));
        return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
      };
      return [gamma(r) * 255, gamma(g) * 255, gamma(bl) * 255];
    };
    // A token ending in '%' is a percentage of its own axis (alpha: 0-100%,
    // oklch chroma/lightness: 0-100% of that axis's own reference range) —
    // only alpha is ever hit here in practice, so '%' is just read as /100.
    const num = (tok: string | undefined, fallback: number): number =>
      tok === undefined ? fallback : parseFloat(tok) / (tok.endsWith('%') ? 100 : 1);

    const parseRGBA = (str: string): [number, number, number, number] => {
      let m = str.match(/^rgba?\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[ ,/]+/).filter(Boolean);
        return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), num(p[3], 1)];
      }
      m = str.match(/^oklch\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[ /]+/).filter(Boolean);
        const [L, C] = [parseFloat(p[0]), parseFloat(p[1])];
        const hRad = parseFloat(p[2]) * Math.PI / 180;
        return [...oklabToSrgb255(L, C * Math.cos(hRad), C * Math.sin(hRad)), num(p[3], 1)];
      }
      m = str.match(/^oklab\(([^)]+)\)$/);
      if (m) {
        const p = m[1].split(/[ /]+/).filter(Boolean);
        return [...oklabToSrgb255(parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])), num(p[3], 1)];
      }
      // 'transparent' and anything unrecognised: alpha 0, so it never
      // contributes to the ancestor background walk below.
      return [0, 0, 0, 0];
    };
    // Composites `fg` over `bg`, both already resolved to opaque channels.
    const over = (fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number, number] => {
      const a = fg[3];
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
    };
    const luminance = ([r, g, b]: [number, number, number, number]): number => {
      const s = (c: number) => { const n = c / 255; return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); };
      return 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
    };
    // Several of the elements below sit on a translucent card (--card-bg is
    // rgba, not opaque) over the page background, so the background actually
    // behind the text is composited down the ancestor chain rather than read
    // off the nearest parent alone.
    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.unshift(n);
    let bg: [number, number, number, number] = [255, 255, 255, 1];
    for (const n of chain) {
      const c = parseRGBA(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) bg = over(c, bg);
    }
    const fg = over(parseRGBA(getComputedStyle(el).color), bg);
    const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  });

  const setTheme = (page: Page, theme: 'light' | 'dark') =>
    page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);

  /**
   * Stop & Score always banks the turn as a win (DiceGame.tsx's `stop` branch
   * dispatches `TURN_BANKED` with `won: true` unconditionally) — the only way
   * this lands on "Bust!" instead is the opening auto-roll itself busting
   * before a selection is ever made, which is rare with six dice. Accepted as
   * the same small flakiness trade-off the rest of this suite takes with
   * random rolls; CI's retry covers it.
   */
  const winATurn = async (page: Page) => {
    await page.getByRole('button', { name: /Roll Dice/i }).click();
    const selectAll = page.getByRole('button', { name: /Select all/i });
    await expect(selectAll).toBeVisible({ timeout: 15000 });
    await selectAll.click();
    await page.getByRole('button', { name: /Stop & Score/i }).click();
  };

  for (const theme of ['light', 'dark'] as const) {
    test(`the goal number clears AA in ${theme} mode`, async ({ page }) => {
      await seedLocalDeck(page);
      await page.goto('/');
      await setTheme(page, theme);
      await startLocalGame(page);

      // The default fallback string in Leaderboard.tsx reads "Goal:" — but
      // en/translation.json overrides it to the same "Goal:", and that
      // loaded string, not the fallback, is what actually renders.
      const goalLine = page.getByText('Goal:');
      await expect(goalLine).toBeVisible();
      expect(await contrastOf(goalLine.locator('strong'))).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`the join-room error text clears AA in ${theme} mode`, async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
      await page.getByRole('button', { name: /Online Play/i }).click();
      await page.getByRole('button', { name: /Join \/ Create/i }).click();

      const error = page.getByText('Please enter both a Room Code and a Name.');
      await expect(error).toBeVisible();
      expect(await contrastOf(error)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    test(`the dice summary's win heading and points-gained value clear AA in ${theme} mode`, async ({ page }) => {
      await seedLocalDeck(page);
      await page.goto('/');
      await setTheme(page, theme);
      await startLocalGame(page);
      await winATurn(page);

      const heading = page.getByRole('heading', { name: 'Success!' });
      await expect(heading).toBeVisible();
      expect(await contrastOf(heading)).toBeGreaterThanOrEqual(AA_LARGE);

      const pointsLine = page.getByText('Points gained:');
      await expect(pointsLine).toBeVisible();
      expect(await contrastOf(pointsLine.locator('strong'))).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});

/**
 * A9 — the fixed HUD (language switcher + theme toggle, App.tsx) used to carry
 * an inline `zIndex: 100` and sit bottom-right at every width, which put it
 * directly over the dice panel's action row (Stop & Score / Roll Again) on a
 * phone — the panel reserves no bottom space for it. The help trigger
 * (HelpPopup.tsx) was `z-50`, the same layer as the dice panel's own backdrop
 * (`.modal-backdrop-under-hud`) and earlier in the DOM, so it lost the paint
 * order tie and was unreachable while the dice panel was open.
 */
test.describe('HUD vs dice panel, help button z-order (A9)', () => {
  interface Box { x: number; y: number; width: number; height: number; }

  const intersects = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  const openDicePanelOnPhone = async (page: Page) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);
    await page.getByRole('button', { name: /Roll Dice/i }).click();
    await expect(page.getByRole('button', { name: /Stop & Score/i })).toBeVisible({ timeout: 15000 });
  };

  test('the language switcher and theme toggle do not cover the dice panel action row at 375x812', async ({ page }) => {
    await openDicePanelOnPhone(page);

    const languageSwitcher = page.getByLabel('Switch to English').locator('xpath=..');
    const themeToggle = page.getByLabel('Toggle theme');
    const stopButton = page.getByRole('button', { name: /Stop & Score/i });
    const rollAgainButton = page.getByRole('button', { name: /Roll Again/i });

    const languageBox = await languageSwitcher.boundingBox();
    const themeBox = await themeToggle.boundingBox();
    const stopBox = await stopButton.boundingBox();
    expect(languageBox).not.toBeNull();
    expect(themeBox).not.toBeNull();
    expect(stopBox).not.toBeNull();

    expect(intersects(languageBox!, stopBox!)).toBe(false);
    expect(intersects(themeBox!, stopBox!)).toBe(false);

    // Roll Again is absent only on the rare turn that already made a tutto —
    // checked when present rather than asserted unconditionally.
    if (await rollAgainButton.isVisible()) {
      const rollAgainBox = await rollAgainButton.boundingBox();
      expect(intersects(languageBox!, rollAgainBox!)).toBe(false);
      expect(intersects(themeBox!, rollAgainBox!)).toBe(false);
    }
  });

  test('the help trigger sits above the dice panel backdrop and stays clickable at 375x812', async ({ page }) => {
    await openDicePanelOnPhone(page);

    const helpButton = page.getByTitle('Open Help / Wiki');
    const backdrop = page.locator('.modal-backdrop-under-hud');
    await expect(backdrop).toBeVisible();
    await expect(helpButton).toBeVisible();

    const helpZ = Number(await helpButton.evaluate(el => getComputedStyle(el).zIndex));
    const backdropZ = Number(await backdrop.evaluate(el => getComputedStyle(el).zIndex));
    expect(helpZ).toBeGreaterThan(backdropZ);

    await helpButton.click();
    await expect(page.getByRole('heading', { name: 'Tutto Wiki' })).toBeVisible();
  });

  /**
   * A10 — the HUD also sits over whatever the current screen puts in its own
   * top-right corner, not just the dice panel: the Scoreboard's Score tile
   * during ordinary play, and the centred main heading on Home. The dice
   * panel case above got the HUD moved up; this carves out a phone-only strip
   * at the App level so no screen's first row lands under it, regardless of
   * what that screen renders there.
   */
  test('the language switcher and theme toggle do not cover the Scoreboard tiles at 375x812 with the dice panel closed', async ({ page }) => {
    await seedLocalDeck(page);
    await page.goto('/');
    await startLocalGame(page);
    await page.setViewportSize({ width: 375, height: 812 });
    // Resizing the viewport keeps the prior scroll offset, which at the wider
    // desktop size (used above so the lobby's icon-only "Add" button keeps its
    // accessible name) can leave the top of the page scrolled out of view —
    // scroll back up so the boxes below reflect what a phone visitor actually
    // sees on arrival.
    await page.evaluate(() => window.scrollTo(0, 0));

    const languageSwitcher = page.getByLabel('Switch to English').locator('xpath=..');
    const themeToggle = page.getByLabel('Toggle theme');
    // The tile label sits directly inside its tile container (Scoreboard.tsx),
    // so one level up from the label text is the whole tile's bounding box.
    const currentPlayerTile = page.getByText('Current Player').locator('xpath=..');
    // 'Score' alone also names the Leaderboard's column header further down
    // the page (Leaderboard.tsx) — .first() takes the Scoreboard's own tile,
    // which renders earlier in the DOM.
    const scoreTile = page.getByText('Score', { exact: true }).first().locator('xpath=..');

    const languageBox = await languageSwitcher.boundingBox();
    const themeBox = await themeToggle.boundingBox();
    const currentPlayerBox = await currentPlayerTile.boundingBox();
    const scoreBox = await scoreTile.boundingBox();
    expect(languageBox).not.toBeNull();
    expect(themeBox).not.toBeNull();
    expect(currentPlayerBox).not.toBeNull();
    expect(scoreBox).not.toBeNull();

    expect(intersects(languageBox!, currentPlayerBox!)).toBe(false);
    expect(intersects(themeBox!, currentPlayerBox!)).toBe(false);
    expect(intersects(languageBox!, scoreBox!)).toBe(false);
    expect(intersects(themeBox!, scoreBox!)).toBe(false);
  });

  test('the language switcher and theme toggle do not cover the Home screen main heading at 375x812', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const languageSwitcher = page.getByLabel('Switch to English').locator('xpath=..');
    const themeToggle = page.getByLabel('Toggle theme');
    const heading = page.getByRole('heading', { level: 1 });

    const languageBox = await languageSwitcher.boundingBox();
    const themeBox = await themeToggle.boundingBox();
    const headingBox = await heading.boundingBox();
    expect(languageBox).not.toBeNull();
    expect(themeBox).not.toBeNull();
    expect(headingBox).not.toBeNull();

    expect(intersects(languageBox!, headingBox!)).toBe(false);
    expect(intersects(themeBox!, headingBox!)).toBe(false);
  });
});
