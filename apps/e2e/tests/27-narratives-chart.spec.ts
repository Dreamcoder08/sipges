import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { seedNonIsoNarratives } from '../support/narratives.ts';

/**
 * functional-closure S12 «aun aun no sale los graficos de la narrativas»: narratives whose dates
 * are not ISO still draw the trend in Registros › Narrativas and the compact chart in Análisis.
 */
test('narratives with non-ISO dates show their charts', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await seedNonIsoNarratives(page, Date.now());

  await page.goto('/narrativas');
  const trend = page
    .getByRole('heading', { name: 'Tendencia temporal de narrativas' })
    .locator('xpath=ancestor::section[1]');
  await expect(trend.locator('svg polyline').first()).toBeVisible();
  await expect(trend.locator('li').filter({ hasText: 'Medio ambiente' })).toBeVisible();
  // Only the non-ISO dates above reach 2030, so the window ends on their last day.
  const lastRow = trend.getByRole('row').last();
  await expect(lastRow.getByRole('rowheader')).toHaveText(/^08\Wene$/);

  await page.goto('/situacion');
  const overview = page
    .getByRole('heading', { name: 'Narrativas por categoría y en el tiempo' })
    .locator('xpath=ancestor::section[1]');
  await expect(overview.locator('dt').filter({ hasText: 'Gobernanza' })).toBeVisible();
  await expect(overview.locator('svg polyline').first()).toBeVisible();
  await expect(overview.getByRole('row').last().getByRole('rowheader')).toHaveText(/^08\Wene$/);
});
