import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Registros on a 360 px phone (odd/tasks/closure-roadmap.md T31, audit L10): the facets live in
 * one «Filtros» sheet, so the first record row is on screen without scrolling past filters, and
 * an active filter shows as a chip that removes it. With SIPGES_SCREENSHOT=<file>.png the list is
 * saved as <file>.png and the open sheet as <file>-sheet.png.
 */
test('Registros shows its first row at 360 px and keeps filters in one sheet', async ({
  page,
  admin,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const stamp = Date.now();
  const created = await page.request.post('/api/eventos', {
    headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
    data: {
      payload: {
        ID_Evento: `EV-F-${stamp}`,
        Fecha: '2026-10-12',
        Territorio: 'Vice, Sechura',
        Descripcion_Hecho: `Asamblea sintética para filtros ${stamp}`,
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);

  await page.goto('/registros');
  const table = page.getByRole('region', { name: 'Tabla de registros' });
  const first = table.getByRole('row').nth(1);
  await expect(first).toBeVisible();
  const shot = process.env.SIPGES_SCREENSHOT;
  if (shot) await page.screenshot({ path: shot });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const box = await first.boundingBox();
  expect((box?.y ?? Infinity) + (box?.height ?? 0)).toBeLessThanOrEqual(640);
  // Between the search and the table sits one row of controls (Filtros, density, count), not
  // the A–E and validation rows the audit found stacked there.
  const search = await page.getByRole('searchbox', { name: 'Buscar en registros' }).boundingBox();
  const top = (await table.boundingBox())?.y ?? Infinity;
  expect(top - ((search?.y ?? 0) + (search?.height ?? 0))).toBeLessThanOrEqual(112);

  // One button opens the sheet; a choice there becomes a removable chip under the search.
  await page.getByRole('button', { name: /^Filtros/ }).tap();
  const sheet = page.getByRole('dialog', { name: 'Filtros' });
  await expect(sheet).toBeVisible();
  await sheet
    .getByRole('group', { name: 'Verificación A a E' })
    .getByRole('button', { name: 'A' })
    .tap();
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-sheet.png') });
  expect((await analyzeAccessibility(page)).violations).toEqual([]);
  await sheet.getByRole('button', { name: /^Ver \d+ registros?$/ }).tap();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filtros 1' })).toBeVisible();
  const chip = page.getByRole('button', { name: 'Quitar filtro Verificación A' });
  await expect(chip).toBeVisible();
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, '-chips.png') });
  expect((await analyzeAccessibility(page)).violations).toEqual([]);
  await chip.tap();
  await expect(chip).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filtros', exact: true })).toBeVisible();
  await expect(first).toBeVisible();
});
