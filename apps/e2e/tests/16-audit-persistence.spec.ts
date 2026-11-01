import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

test('CSV imports refresh the cached dashboard and uploaded evidence refreshes the source list', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/');
  const counter = page
    .locator('dl > div')
    .filter({ hasText: 'Demandas abiertas' })
    .locator('dd')
    .first();
  const before = Number(await counter.innerText());
  await page.locator('a[href="/demandas"]').first().click();
  await page.getByRole('button', { name: 'Importar CSV' }).click();
  const description = `Solicitud CSV de prueba ${Date.now()}`;
  await page.getByLabel(/Archivo CSV/).setInputFiles({
    name: 'demanda-prueba.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Descripcion,Estado\n${description},Nueva\n`),
  });
  await page.getByRole('button', { name: 'Revisar importación' }).click();
  await expect(page.getByText('Listo para importar:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByText('Importación completada:', { exact: false })).toBeVisible();
  await page.locator('a[href="/"]').first().click();
  await expect(counter).toHaveText(String(before + 1));

  const id = `F-CACHE-${Date.now()}`;
  expect(
    (
      await page.request.post('/api/fuentes', {
        headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
        data: { payload: { ID_Fuente: id, Archivo_Fuente: 'Documento de prueba del contador' } },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/fuentes');
  // Uploads update Archivo_Fuente to the actual filename (the prototype's contract).
  // Keep tracking the source by its stable record id, not its mutable title.
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: `Ver ${id}` }) });
  await expect(row).toContainText('Sin archivo almacenado');
  await row.getByRole('button', { name: `Ver ${id}` }).click();
  await page.getByLabel('Archivo de evidencia').setInputFiles({
    name: 'contador.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Contenido sintético para probar el contador de archivos.'),
  });
  await page.getByRole('button', { name: 'Subir evidencia' }).click();
  await expect(page.getByText('Evidencia guardada.')).toBeVisible();
  await page.getByRole('button', { name: 'Volver a la lista' }).click();
  await expect(row).toContainText('1 archivo(s)');
});

test('directory pagination reaches a stored contact beyond the API first page', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const stamp = Date.now();
  const city = `Ciudad paginada ${stamp}`;
  const name = `Contacto paginado ${stamp}`;
  const created = await page.request.post('/api/directorio', {
    headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
    data: {
      payload: { Nombre: name, Ciudad: city, Cargo: 'Cargo de prueba', Telefono: '000 000 000' },
    },
  });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const rows = Array.from({ length: 500 }, (_, n) => ({
    Nombre: `Contacto de prueba ${n}`,
    Ciudad: city,
  }));
  const response = await page.request.post('/system/import/directorio', {
    headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
    data: { rows, dry_run: false, source: 'pagination-test.csv' },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ created: 500, updated: 0 });
  await page.goto('/directorio');
  await page.getByLabel('Territorio / ciudad').selectOption(city);
  await expect(page.getByRole('button', { name: `Ver ${id}` })).toHaveCount(0);
  for (let number = 2; number <= 11; number++) {
    await page.getByRole('button', { name: 'Página siguiente' }).click();
    await expect(page.getByText(`Página ${number} de 11`, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: `Ver ${id}` }).click();
  await expect(page.getByRole('heading', { name: `Ficha ${id}` })).toBeFocused();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText('000 000 000', { exact: true })).toBeVisible();
});
