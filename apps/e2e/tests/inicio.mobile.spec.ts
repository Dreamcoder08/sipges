import path from 'node:path';
import { analyzeAccessibility } from '../support/accessibility.ts';
import type { Locator } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return rect;
};

/**
 * At the narrowest phone (360 px) «Esta semana» is one line of links, no cards (chat-first-ui
 * T19, direction 01): each link stays on one line and the line never widens the page.
 */
test('the week on a 360 px phone is a line of one-line links', async ({ page, admin }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  const week = page.getByRole('region', { name: 'Esta semana' });
  await expect(week.getByRole('link', { name: 'Riesgo por localidad' })).toHaveAttribute(
    'href',
    '/analisis?vista=riesgo',
  );
  await expect(week.getByRole('link', { name: /^IRSA/ })).toHaveAttribute('href', '/analisis');
  await expect(week.getByRole('heading')).toHaveCount(0);
  for (const link of await week.getByRole('link').all()) {
    expect((await box(link)).height, 'each week link stays on one line').toBeLessThanOrEqual(32);
  }
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.view);
});

/**
 * The first thing that needs attention (or the calm empty state) is on screen at 360 × 780 without
 * scrolling (closure-roadmap L10: a ~490 px blank band pushed it down), and the status line wraps
 * instead of clipping its items.
 */
test('the first attention row is visible on a 360 px phone without scrolling', async ({
  page,
  admin,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  const attention = page.getByRole('region', { name: 'Necesita tu atención' });
  const first = attention
    .getByRole('listitem')
    .or(attention.getByText('Nada necesita tu atención ahora.'))
    .first();
  await expect(first).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const row = await box(first);
  expect(row.y + row.height).toBeLessThanOrEqual(780);
  const status = page.getByText('IA externa desactivada');
  await expect(status).toBeVisible();
  const clipped = await status
    .locator('xpath=..')
    .evaluate((line) =>
      [...line.children].some(
        (item) =>
          item.scrollWidth > item.clientWidth + 1 ||
          item.getBoundingClientRect().right > document.documentElement.clientWidth,
      ),
    );
  expect(clipped, 'no status item is clipped or pushed off screen').toBe(false);
  const dir = process.env.SIPGES_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, '01-implemented-360.png') });
});

/**
 * The suggestion strip hides its scrollbar, so a fade at each edge is the only cue that more chips
 * lie that way (modern-web-guidance scrollability-affordance-hints). It follows the scroll with a
 * scroll-driven animation, or with an observer under reduced motion, and clears at either end.
 */
for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`the 360 px suggestion strip fades where more chips lie (${reducedMotion})`, async ({
    page,
    admin,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ reducedMotion });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inicio');
    const strip = page.getByRole('list', { name: 'Prueba con' });
    await expect(strip.getByRole('button').first()).toBeVisible();
    const fades = () =>
      strip.evaluate((node) => {
        const style = getComputedStyle(node);
        const px = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
        return { start: px('--fade-start') > 0, end: px('--fade-end') > 0 };
      });
    await expect.poll(fades).toEqual({ start: false, end: true });
    await strip.evaluate((node) => node.scrollTo({ left: node.scrollWidth, behavior: 'instant' }));
    await expect.poll(fades).toEqual({ start: true, end: false });
  });
}

/**
 * Inicio on a phone: greeting and status line, what needs attention, the week's line of links,
 * the suggestions in one swipeable strip and the composer resting at the bottom of the screen.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`Inicio on a phone is a chat-style home (${colorScheme})`, async ({ page, admin }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inicio');

    const field = page.getByRole('textbox', { name: /^Buscar en registros de / });
    const composer = page.locator('form').filter({ has: field });
    await expect(composer).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Hola/ })).toBeVisible();

    // The date line is desktop chrome; the header already names the project.
    const date = page.getByText(/^\S+, \d{1,2} de \S+ de \d{4}/);
    await expect(date).toHaveCount(1);
    await expect(date).toBeHidden();

    // The composer rests at the bottom of the screen without scrolling (no bottom bar).
    const composerBox = await box(composer);
    const height = page.viewportSize()?.height ?? 0;
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(height);
    expect(height - (composerBox.y + composerBox.height)).toBeLessThanOrEqual(24);

    // The week is one line of links, above the suggestions (chat-first-ui T19).
    const week = page.getByRole('region', { name: 'Esta semana' });
    await expect(week.getByRole('link').first()).toBeVisible();
    expect((await box(week)).y).toBeLessThan(
      (await box(page.getByRole('list', { name: 'Prueba con' }))).y,
    );

    // Suggestions share one line and never widen the page.
    const chips = page.getByRole('list', { name: 'Prueba con' }).getByRole('button');
    const tops = new Set<number>();
    for (const chip of await chips.all()) tops.add(Math.round((await box(chip)).y));
    expect(tops.size).toBe(1);
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.view);

    // The narrowest supported phone (360 px) keeps the composer, its send button included, inside the width.
    // A long project name stands in for wider fonts (CI renders with DejaVu Sans).
    await page.setViewportSize({ width: 360, height: 780 });
    if (process.env.SIPGES_SCREENSHOT_DIR) {
      await page.screenshot({
        path: path.join(process.env.SIPGES_SCREENSHOT_DIR, `inicio-360-${colorScheme}.png`),
        animations: 'disabled',
      });
    }
    await composer.getByText(/^Buscar en registros de /).evaluate((node) => {
      if (node.lastChild)
        node.lastChild.textContent =
          'Buscar en registros de Proyecto con un nombre muy largo (migración)';
    });
    const narrow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(narrow.scroll).toBeLessThanOrEqual(narrow.view);
    const send = await box(page.getByRole('button', { name: 'Buscar en registros' }));
    expect(send.x + send.width).toBeLessThanOrEqual(360);

    // A suggestion still fills the composer.
    await chips.first().tap();
    await expect(field).toHaveValue(/\S/);

    const result = await analyzeAccessibility(page);
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
}
