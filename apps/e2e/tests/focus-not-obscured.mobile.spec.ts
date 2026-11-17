import type { APIRequestContext, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum) on a phone, the companion of
 * 31-focus-not-obscured.spec.ts: Inicio's composer rests on the bottom of the screen (sticky), so
 * the attention rows, the week and the suggestion chips scroll under it. Scrolled to the end,
 * nothing stays under it, and Tab or Shift+Tab never leaves the focused control under it, also
 * after a long question has made the composer taller. At rest and at any scroll position the page
 * reserves the composer's strip: no content shows under or around it («Esta semana» at 360 px).
 */

/** The composer form, found by its field. */
const composerOf = (page: Page) =>
  page.locator('main form').filter({ has: page.getByRole('textbox', { name: /^Buscar en / }) });

/** Why the focused control is under the composer, '' when it is clear, 'left' outside main. */
const underComposer = (page: Page) =>
  composerOf(page).evaluate((form) => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || !target.closest('main')) return 'left';
    if (form.contains(target)) return '';
    const box = target.getBoundingClientRect();
    const bar = form.getBoundingClientRect();
    // Chips of the sideways strip may sit past the screen edge; only the vertical cover counts.
    const x = Math.min(Math.max(box.left + box.width / 2, 1), window.innerWidth - 1);
    const hit = document.elementFromPoint(x, box.top + box.height / 2);
    if (!hit || !form.contains(hit)) return '';
    const name = (target.getAttribute('aria-label') ?? target.textContent ?? '').trim();
    return `«${name.slice(0, 32)}» (${Math.round(box.top)}–${Math.round(box.bottom)}) is under the composer (${Math.round(bar.top)}–${Math.round(bar.bottom)})`;
  });

/**
 * Waits until the page's bottom scroll padding covers the composer from its top edge to the bottom
 * of the screen. The composer reports its height one frame after it renders or grows
 * (ResizeObserver, then requestAnimationFrame); a key pressed sooner, as only a script can, would
 * scroll the focused control clear of the composer's previous height (WebKit, a long question).
 */
const composerReserved = (page: Page) =>
  expect
    .poll(
      () =>
        composerOf(page).evaluate(
          (form) =>
            Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) -
            (window.innerHeight - form.getBoundingClientRect().top),
        ),
      { message: "the scroll padding covers the composer's strip (px to spare)" },
    )
    .toBeGreaterThanOrEqual(0);

/** Presses `key` up to `times` times while the focus stays in main, recording every cover. */
const walk = async (page: Page, key: string, times: number) => {
  const problems: string[] = [];
  for (let step = 1; step <= times; step += 1) {
    await page.keyboard.press(key);
    const problem = await underComposer(page);
    if (problem === 'left') break;
    if (problem) problems.push(`${key} #${step}: ${problem}`);
  }
  return problems;
};

/**
 * Content of the page that shows from the composer's top edge to the bottom of the screen: the
 * strip the layout reserves for the composer. Each entry names the content and one point it shows at.
 */
const contentInComposerStrip = (page: Page) =>
  composerOf(page).evaluate((form) => {
    const top = Math.ceil(form.getBoundingClientRect().top) + 1;
    const found = new Map<string, string>();
    for (let y = top; y < window.innerHeight; y += 4) {
      for (let x = 2; x < window.innerWidth - 1; x += 6) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || form.contains(hit)) continue;
        const content = hit.closest('main header, main section, main li');
        if (!content) continue;
        const name = (content.textContent ?? '').trim().slice(0, 32);
        if (!found.has(name)) found.set(name, `«${name}» at ${x},${y}`);
      }
    }
    return [...found.values()];
  });

/** Open alerts with long causes, as in the review captures: the page outgrows the screen. */
const seedLongAlerts = async (adminApi: APIRequestContext) => {
  for (let n = 1; n <= 6; n += 1) {
    const created = await adminApi.post('/api/alertas', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: {
        payload: {
          Causa: `Alerta sintética por convocatoria a asamblea ${n} ${Date.now()}`,
          Nivel_Preliminar: 'Naranja',
        },
      },
    });
    expect(created.status(), await created.text()).toBe(200);
  }
};

for (const width of [360, 412] as const) {
  test(`Inicio at ${width} px reserves the composer's strip at rest and while scrolling`, async ({
    page,
    admin,
    adminApi,
  }) => {
    await seedLongAlerts(adminApi);
    await page.setViewportSize({ width, height: 640 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inicio');
    await expect(
      page.getByRole('region', { name: 'Esta semana' }).getByRole('link', { name: /^IRSA/ }),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Prueba con' }).getByRole('button')).toHaveCount(4);
    const end = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(end, 'the page must scroll, or the check proves nothing').toBeGreaterThan(0);

    const shown: string[] = [];
    for (const share of [0, 0.25, 0.5, 0.75, 1]) {
      const y = Math.round(end * share);
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(y);
      for (const item of await contentInComposerStrip(page)) shown.push(`scrollY ${y}: ${item}`);
    }
    expect(shown, `content under Inicio's composer at ${width} px`).toEqual([]);
  });

  test(`Inicio at ${width} px keeps the focused control clear of its sticky composer`, async ({
    page,
    admin,
    adminApi,
  }) => {
    await seedLongAlerts(adminApi);
    await page.setViewportSize({ width, height: 640 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inicio');
    const composer = composerOf(page);
    await expect(
      page.getByRole('region', { name: 'Esta semana' }).getByRole('link', { name: /^IRSA/ }),
    ).toBeVisible();
    await expect(page.getByRole('list', { name: 'Prueba con' }).getByRole('button')).toHaveCount(4);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
      'the page must scroll, or the walk proves nothing',
    ).toBe(true);

    // Reachable: scrolled to the end, the rows, the week and the chips sit above the composer.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const left = await composer.evaluate((form) => {
      const top = form.getBoundingClientRect().top;
      return [...document.querySelectorAll('main li, main section h3')]
        .filter((node) => !form.contains(node))
        .filter((node) => node.getBoundingClientRect().bottom > top + 0.5)
        .map((node) => (node.textContent ?? '').trim().slice(0, 32));
    });
    expect(left, 'content left under the composer at the end of the page').toEqual([]);

    // Focus: from the top, Tab through the content and Shift+Tab back.
    await page.evaluate(() => window.scrollTo(0, 0));
    await composerReserved(page);
    await page.getByRole('link', { name: 'Abrir Bandeja' }).focus();
    const forward = await walk(page, 'Tab', 30);
    const back = await walk(page, 'Shift+Tab', 30);

    // A long question makes the composer taller; the chips and the week still clear it.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page
      .getByRole('textbox', { name: /^Buscar en / })
      .fill(
        ['Una pregunta larga', 'en varias líneas', 'sobre las demandas', 'abiertas'].join('\n'),
      );
    await composerReserved(page);
    await page.getByRole('button', { name: 'Buscar en registros' }).focus();
    const grown = await walk(page, 'Tab', 10);

    expect([...forward, ...back, ...grown], `SC 2.4.11 on Inicio at ${width} px`).toEqual([]);
  });
}
