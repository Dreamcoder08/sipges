import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

// ODD territorial-3d: the WebGL map tilts into a 3D view of record columns and back.
test('the territorial map switches to a 3D view of documented records and back', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/mapa');
  const map = page.locator('[data-map-engine="maplibre"]');
  await expect(map).toHaveAttribute('data-map-view', '2d');
  const toggle = page.getByRole('button', { name: 'Vista 3D' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Norte arriba' })).toHaveCount(0);

  await toggle.click();
  await expect(map).toHaveAttribute('data-map-view', '3d');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/cada columna reúne los registros documentados/)).toBeVisible();
  await page.getByRole('button', { name: 'Norte arriba' }).click();

  await toggle.click();
  await expect(map).toHaveAttribute('data-map-view', '2d');
  await expect(page.getByText(/cada columna reúne los registros documentados/)).toHaveCount(0);
});
