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
    page.getByRole('heading', { level: 1, name: 'Mapa territorial SIPGES' }),
  ).toBeVisible();
  // MapLibre GL JS + deck.gl where WebGL 2 exists, the SVG renderer otherwise (ADR 0017).
  const map = page.getByLabel('Mapa territorial de la provincia de Sechura');
  await expect(map).toBeVisible();
  await page.getByRole('button', { name: 'Acercar', exact: true }).click();
  await page.getByRole('button', { name: 'Alejar', exact: true }).click();
  await page.getByRole('button', { name: 'Ver toda la provincia', exact: true }).click();
  // Dragging the map keeps the page usable and never selects anything.
  const box = await map.boundingBox();
  if (!box) throw new Error('Missing map box');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, { steps: 6 });
  await page.mouse.up();

  // The evolution timeline selects the record and opens its sheet with its provenance.
  const evolution = page.getByRole('list', { name: 'Registros del periodo' });
  const entry = evolution.getByRole('button', { name: new RegExp(description) });
  await entry.click();
  await expect(entry).toHaveAttribute('aria-pressed', 'true');
  const sheet = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Ficha territorial' }) });
  await expect(sheet.getByRole('heading', { name: description })).toBeVisible();
  await expect(sheet.getByText('Aproximada al centro de la localidad')).toBeVisible();
  await expect(sheet.getByText('Falta verificación A–C y referencia de fuente')).toBeVisible();

  // Estimated records can be hidden; the filters apply to the map and the evolution alike.
  await page.getByRole('checkbox', { name: 'Estimado', exact: true }).uncheck();
  await expect(entry).toBeHidden();
  await page.getByRole('checkbox', { name: 'Estimado', exact: true }).check();
  await expect(entry).toBeVisible();
  await page.getByLabel('Localidad').selectOption('Bayóvar');
  await expect(entry).toBeHidden();

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
