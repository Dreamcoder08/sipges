import type { Locator, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { settleAnimations } from '../support/accessibility.ts';

/**
 * rc8 visual review (escritorio-inicio*.png): the alerts donut's hole was painted with the last
 * level's colour, leaving «abiertas» at about 1.2:1. Axe cannot tell what is painted behind SVG
 * text and files it as «incomplete», which 07-accessibility ignores; this measures the pixels
 * actually painted behind each label instead.
 */
type Rgb = [number, number, number];

const luminance = ([r, g, b]: Rgb) => {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The label's own colour, resolved by the browser to sRGB (tokens may use any colour space). */
const textColour = (label: Locator) =>
  label.evaluate((node): Rgb => {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.fillStyle = getComputedStyle(node).fill;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  });

/** The most frequent colour painted under the label's box while the label is hidden. */
const paintedBehind = async (page: Page, label: Locator) => {
  const box = await label.boundingBox();
  if (!box) throw new Error('label has no box');
  await label.evaluate((node) => ((node as SVGElement).style.visibility = 'hidden'));
  const png = await page.screenshot({ clip: box, scale: 'css', animations: 'disabled' });
  await label.evaluate((node) => ((node as SVGElement).style.visibility = ''));
  return page.evaluate(
    async (bytes): Promise<Rgb> => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const counts = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const [top] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['0,0,0'];
      return top.split(',').map(Number) as Rgb;
    },
    [...png],
  );
};

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the alerts donut keeps its centre labels readable (${colorScheme})`, async ({
    page,
    admin,
    adminApi,
  }) => {
    // An open red alert: red is the last level drawn, the one that used to fill the hole.
    const created = await adminApi.post('/api/alertas', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: { payload: { Causa: 'Alerta sintética del anillo', Nivel_Preliminar: 'Rojo' } },
    });
    expect(created.status(), await created.text()).toBe(200);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/');
    const donut = page
      .locator('figure')
      .filter({ has: page.getByLabel('Alertas abiertas por nivel', { exact: true }) })
      .locator('svg');
    const caption = donut.locator('text').filter({ hasText: 'abiertas' });
    await expect(caption).toBeVisible();
    await expect(donut.locator('text').first()).not.toHaveText('0');
    await caption.scrollIntoViewIfNeeded();
    await settleAnimations(page);
    for (const label of [donut.locator('text').first(), caption]) {
      const ratio = contrast(await textColour(label), await paintedBehind(page, label));
      expect
        .soft(ratio, `${await label.textContent()} (${colorScheme})`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
}
