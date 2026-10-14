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
  const map = page.getByRole('group', {
    name: 'Mapa territorial de la provincia de Sechura',
  });
  const provinceView = await map.getAttribute('viewBox');
  if (!provinceView) throw new Error('Missing map extent');
  await page.getByRole('button', { name: 'Acercar', exact: true }).click();
  await expect(map).not.toHaveAttribute('viewBox', provinceView);
  await page.getByRole('button', { name: 'Alejar', exact: true }).click();
  await page.getByRole('button', { name: 'Ver toda la provincia', exact: true }).click();
  await expect(map).toHaveAttribute('viewBox', provinceView);
  // Dragging moves the map; the arrow keys too once it has focus.
  await map.scrollIntoViewIfNeeded();
  const box = await map.boundingBox();
  if (!box) throw new Error('Missing map box');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, { steps: 6 });
  // While the finger or mouse moves, only a transform follows it; the page renders on release.
  const content = map.locator('[data-map-content]');
  await expect(content).toHaveAttribute('transform', /scale\(1\)/);
  await expect(map).toHaveAttribute('viewBox', provinceView);
  await page.mouse.up();
  await expect(content).not.toHaveAttribute('transform');
  await expect(map).not.toHaveAttribute('viewBox', provinceView);
  await page.getByRole('button', { name: 'Ver toda la provincia', exact: true }).click();
  await map.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(map).not.toHaveAttribute('viewBox', provinceView);
  await page.keyboard.press('0');
  await expect(map).toHaveAttribute('viewBox', provinceView);
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
  const location = page.getByLabel('Geometría de referencia');
  await expect(location).toBeVisible();
  // Satellite imagery by default, with its credit; streets on request.
  const basemaps = page.getByRole('group', { name: 'Mapa base' });
  await expect(basemaps.getByLabel('Satélite')).toBeChecked();
  await expect(
    location.locator('image[href^="https://tiles.maps.eox.at/"]').first(),
  ).toBeAttached();
  await expect(page.getByRole('link', { name: /Sentinel-2 cloudless 2020/ })).toBeVisible();
  await basemaps.getByLabel('Calles').check();
  await expect(
    location.locator('image[href^="https://tile.openstreetmap.org/"]').first(),
  ).toBeAttached();
  await expect(location.locator('image[href^="https://tiles.maps.eox.at/"]')).toHaveCount(0);
});
