import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { seedNonIsoNarratives } from '../support/narratives.ts';

/** The narratives trend with non-ISO dates draws and fits a 360 px phone (functional-closure S12). */
test('narratives trend fits a phone at 360 px', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await seedNonIsoNarratives(page, Date.now());
  await page.setViewportSize({ width: 360, height: 800 });
  for (const [path, title] of [
    ['/narrativas', 'Tendencia temporal de narrativas'],
    ['/situacion', 'Narrativas por categoría y en el tiempo'],
  ] as const) {
    await page.goto(path);
    const chart = page
      .getByRole('heading', { name: title })
      .locator('xpath=ancestor::section[1]')
      .locator('svg polyline')
      .first();
    await expect(chart).toBeVisible();
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(widths.scroll, `${path} at 360px`).toBeLessThanOrEqual(widths.view);
  }
});
