import { readFile } from 'node:fs/promises';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

test('territorial record CRUD with evidence upload and byte-exact download', async ({
  page,
  admin,
}) => {
  const name = `Fuente sintética ${Date.now()}`;
  const evidence = Buffer.from(`Acta sintética E2E ${Date.now()}\nSegunda línea.\n`, 'utf8');
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/fuentes');
  await expect(page.getByRole('heading', { level: 1, name: 'Fuentes y evidencias' })).toBeVisible();

  // Create
  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  await page.getByLabel('Nombre de la fuente o documento').fill(name);
  await page.getByLabel('Tipo de fuente').selectOption('Acta');
  await page.getByLabel('Institución o autor').fill('Institución sintética');
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  const created = page.getByRole('row').filter({ hasText: name });
  await expect(created).toBeVisible();
  const view = created.getByRole('button', { name: /^Ver / });
  const id = ((await view.getAttribute('aria-label')) ?? '').replace(/^Ver /, '');
  expect(id).not.toBe('');
  // Follow the record by id: linking evidence may update the displayed source file name.
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: `Ver ${id}` }) });

  // Read + upload evidence to the saved record
  await view.click();
  await expect(page.getByRole('heading', { name: `Ficha ${id}` })).toBeVisible();
  await page
    .getByLabel('Archivo de evidencia')
    .setInputFiles({ name: 'acta-e2e.txt', mimeType: 'text/plain', buffer: evidence });
  await page.getByLabel('Tipo de documento').fill('Acta');
  await page.getByLabel('Autor de la evidencia').fill('Equipo sintético');
  await page.getByRole('button', { name: 'Subir evidencia' }).click();
  await expect(page.getByText('Evidencia guardada.')).toBeVisible();

  // Download goes through the scoped API and returns the exact bytes.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar acta-e2e.txt' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('acta-e2e.txt');
  expect(Buffer.compare(await readFile((await download.path()) ?? ''), evidence)).toBe(0);

  // Update keeps the evidence link.
  await page.getByRole('button', { name: `Editar ${id}` }).click();
  await page.getByLabel('Observaciones').fill('Observación editada E2E');
  // Delay the write so the test cannot pass by reading before the save finishes: the button
  // turns into "Guardando…" at once, so only the success notice proves the PUT completed.
  const recordUrl = `**/api/fuentes/${encodeURIComponent(id)}`;
  await page.route(recordUrl, async (route) => {
    if (route.request().method() === 'PUT') await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByText(`Registro ${id} guardado.`, { exact: false })).toBeVisible();
  await page.unroute(recordUrl);
  const stored = await page.request.get(`/api/fuentes/${encodeURIComponent(id)}`);
  expect(await stored.json()).toMatchObject({ _id: id, Observaciones: 'Observación editada E2E' });
  await page.getByRole('button', { name: `Ver ${id}` }).click();
  await expect(page.getByRole('button', { name: 'Descargar acta-e2e.txt' })).toBeVisible();

  // Delete: cancel first, then confirm.
  await page.getByRole('button', { name: `Eliminar ${id}` }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Eliminar registro' });
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: `Eliminar ${id}` }).click();
  await dialog.getByRole('button', { name: 'Confirmar eliminación' }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.get(`/api/fuentes/${encodeURIComponent(id)}`)).status()).toBe(404);
});

test('event and demand screens create records in the active project', async ({ page, admin }) => {
  const stamp = Date.now();
  await signInToProject(page, admin, DEFAULT_SCOPE);

  await page.goto('/eventos');
  await page.getByRole('button', { name: 'Nuevo registro' }).click();
  await page.getByLabel('Territorio').fill('Caleta sintética');
  await page.getByLabel('Descripción del hecho').fill(`Reunión sintética ${stamp}`);
  await page.getByLabel('Relevancia preliminar').selectOption('Alta');
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByRole('cell', { name: `Reunión sintética ${stamp}` })).toBeVisible();

  await page.getByLabel('Buscar registros').fill('sin-coincidencias-e2e');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.getByText('Sin registros para esta búsqueda.')).toBeVisible();

  await page.goto('/demandas');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Demandas y compromisos' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Compromisos' }).click();
  await expect(page.getByRole('button', { name: 'Compromisos' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
