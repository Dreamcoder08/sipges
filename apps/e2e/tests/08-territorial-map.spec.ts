import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

test('events with a known locality appear on the territorial map with their detail', async ({
  page,
  admin,
}) => {
  const description = `Mesa de diálogo distrital ${Date.now()}`;
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/eventos');
  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  await page.getByLabel('Fecha').fill('2026-10-10');
  await page.getByLabel('Territorio').fill('Vice, Sechura');
  await page.getByLabel('Descripción del hecho').fill(description);
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByRole('row').filter({ hasText: description })).toBeVisible();

  await page.goto('/mapa');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Mapa territorial MASCLI' }),
  ).toBeVisible();
  const marker = page.getByRole('button', { name: `Eventos: ${description} (Vice)` });
  await marker.click();
  await expect(marker).toHaveAttribute('aria-pressed', 'true');
  const detail = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Detalle del punto seleccionado' }) });
  await expect(detail.getByText(description)).toBeVisible();

  await page.getByLabel('Localidad').selectOption('Bayóvar');
  await expect(marker).toBeHidden();

  await page.goto('/ubicacion');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ubicación geoespacial del proyecto' }),
  ).toBeVisible();
  await expect(page.getByLabel('Geometría de referencia')).toBeVisible();
});
