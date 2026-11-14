import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum) on a phone, the companion of
 * 31-focus-not-obscured.spec.ts: Inicio's composer rests on the bottom of the screen (sticky), so
 * the attention rows, the week and the suggestion chips scroll under it. Scrolled to the end,
 * nothing stays under it, and Tab or Shift+Tab never leaves the focused control under it, also
 * after a long question has made the composer taller.
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

for (const width of [360, 412] as const) {
  test(`Inicio at ${width} px keeps the focused control clear of its sticky composer`, async ({
    page,
    admin,
    adminApi,
  }) => {
    // Open alerts with long causes, as in the review captures: the page outgrows the screen.
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
    await page.setViewportSize({ width, height: 640 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inicio');
    const composer = composerOf(page);
    await expect(page.getByRole('region', { name: /Riesgo del territorio/ })).toBeVisible();
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
    await page.getByRole('button', { name: 'Buscar en registros' }).focus();
    const grown = await walk(page, 'Tab', 10);

    expect([...forward, ...back, ...grown], `SC 2.4.11 on Inicio at ${width} px`).toEqual([]);
  });
}
