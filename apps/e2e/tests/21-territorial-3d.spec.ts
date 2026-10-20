import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

// ODD territorial-3d: «Vista 3D» opens the CesiumJS terrain view and returns to the 2D map,
// with CesiumJS's workers and assets served under the strict CSP.
test('the territorial map opens a 3D terrain view of documented records and returns', async ({
  page,
  admin,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/mapa');
  await expect(page.locator('[data-map-engine="maplibre"]')).toBeVisible();
  await page.getByRole('button', { name: 'Vista 3D' }).click();

  const terrain = page.locator('[data-map-engine="cesium"]');
  await expect(terrain).toBeVisible({ timeout: 30_000 });
  await expect(terrain.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vista 3D' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(/Cada columna reúne los registros documentados/)).toBeVisible();
  await page.getByRole('button', { name: 'Norte arriba' }).click();

  await page.getByRole('button', { name: 'Vista 3D' }).click();
  await expect(page.locator('[data-map-engine="maplibre"]')).toBeVisible();
  await expect(terrain).toHaveCount(0);
  await expect(page.getByText(/Cada columna reúne los registros documentados/)).toHaveCount(0);
  expect(violations).toEqual([]);
});
