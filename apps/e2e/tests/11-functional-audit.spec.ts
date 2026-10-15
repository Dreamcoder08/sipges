import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Functional audit regressions (odd/tasks/functional-audit-correction.md), end to end on the
 * real API. Records are synthetic.
 */
test('counters follow records and every record opens, edits and shows its report', async ({
  page,
  admin,
}) => {
  const stamp = Date.now();
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const api = (method: 'POST' | 'PUT', path: string, payload: Record<string, unknown>) =>
    page.request.fetch(path, {
      method,
      headers: { 'X-MASCLI-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
      data: { payload },
    });
  const realId = `D-E2E-${stamp}`;

  // Error 01: the counter follows the records.
  await page.goto('/');
  const openDemands = page.locator('dl > div').filter({ hasText: 'Demandas abiertas' });
  await expect(openDemands).toContainText('estado distinto');
  const before = Number(await openDemands.locator('dd').first().innerText());
  expect(
    (
      await api('POST', '/api/demandas', {
        ID_Demanda: realId,
        Estado: 'En diálogo',
        Descripcion: `Demanda real sintética ${stamp}`,
        Respuesta_Empresa: 'Respuesta de matriz',
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await expect(openDemands.locator('dd').first()).toHaveText(String(before + 1));

  await page.goto('/demandas');
  await expect(page.getByRole('cell', { name: `Demanda real sintética ${stamp}` })).toBeVisible();

  // Error 03: «Ver» opens the record with its data; the list returns with focus.
  await page.getByRole('button', { name: `Ver ${realId}` }).click();
  await expect(page.getByRole('heading', { name: `Ficha ${realId}` })).toBeFocused();
  await expect(page.getByText(`Demanda real sintética ${stamp}`)).toBeInViewport();
  await page.getByRole('button', { name: 'Volver a la lista' }).click();
  await expect(page.getByRole('button', { name: `Ver ${realId}` })).toBeFocused();

  // Error 04: the editor carries the description and the matrix columns, and saves them.
  await page.getByRole('button', { name: `Editar ${realId}` }).click();
  await expect(page.getByLabel('Descripción')).toHaveValue(`Demanda real sintética ${stamp}`);
  await page.getByLabel('Respuesta_Empresa').fill('Respuesta actualizada E2E');
  await page.getByRole('button', { name: 'Guardar registro' }).click();
  await expect(page.getByText(`Registro ${realId} guardado.`, { exact: false })).toBeVisible();
  const stored = await page.request.get(`/api/demandas/${realId}`, {
    headers: { 'X-MASCLI-Scope': DEFAULT_SCOPE },
  });
  expect(await stored.json()).toMatchObject({
    Respuesta_Empresa: 'Respuesta actualizada E2E',
    Descripcion: `Demanda real sintética ${stamp}`,
  });

  // Error 05: a stored report opens inside the app with its text.
  const sourceId = `F-E2E-${stamp}`;
  expect(
    (
      await api('POST', '/api/fuentes', { ID_Fuente: sourceId, Archivo_Fuente: `Informe ${stamp}` })
    ).ok(),
  ).toBe(true);
  await page.goto('/fuentes');
  await page.getByRole('button', { name: `Ver ${sourceId}` }).click();
  await page.getByLabel('Archivo de evidencia').setInputFiles({
    name: 'informe-e2e.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`Contenido del informe sintético ${stamp}\n`, 'utf8'),
  });
  await page.getByRole('button', { name: 'Subir evidencia' }).click();
  await expect(page.getByText('Evidencia guardada.')).toBeVisible();
  await page.getByRole('button', { name: 'Ver contenido de informe-e2e.txt' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Contenido de informe-e2e.txt' })
      .getByText(`Contenido del informe sintético ${stamp}`),
  ).toBeVisible();
});

test('the geospatial view frames a concession and the directory lists contacts', async ({
  page,
  admin,
}) => {
  const stamp = Date.now();
  await signInToProject(page, admin, DEFAULT_SCOPE);

  // Error 06: selecting a concession frames it; shapes carry explicit colours.
  await page.goto('/ubicacion');
  const map = page.getByLabel('Geometría de referencia');
  await expect(map).toBeVisible();
  const province = await map.getAttribute('viewBox');
  await page.getByLabel('Concesión', { exact: true }).selectOption('12000442Y01');
  await expect(map).not.toHaveAttribute('viewBox', province ?? '');
  const selected = page.getByRole('button', { name: 'Seleccionar BAYOVAR N° 6' });
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  const fill = await selected.evaluate((path) => getComputedStyle(path).fill);
  expect(fill).not.toBe('rgb(0, 0, 0)');
  const box = await map.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(200);

  // Error 07: directory contacts with position, place and phone, filterable by place.
  const created = await page.request.post('/api/directorio', {
    headers: { 'X-MASCLI-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
    data: {
      payload: {
        Nombre: `Contacto E2E ${stamp}`,
        Cargo: 'Teniente gobernador',
        Ciudad: `Ciudad E2E ${stamp}`,
        Telefono: '900 000 000',
      },
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/directorio');
  await page.getByLabel('Territorio / ciudad').selectOption(`Ciudad E2E ${stamp}`);
  const row = page.getByRole('row').filter({ hasText: `Contacto E2E ${stamp}` });
  await expect(row).toContainText('Teniente gobernador');
  await expect(row).toContainText('900 000 000');
  // The phone stays on one line next to the other columns.
  const phone = row.getByRole('cell', { name: '900 000 000' });
  expect(await phone.evaluate((cell) => getComputedStyle(cell).whiteSpace)).toBe('nowrap');
  const lines = await phone.evaluate((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines).toBe(1);
});

test('narratives show their trend per day and category', async ({ page, admin }) => {
  const stamp = Date.now();
  await signInToProject(page, admin, DEFAULT_SCOPE);
  for (const [day, topic] of [
    ['2026-10-01', `Calidad del agua ${stamp}`],
    ['2026-10-03', `Demanda de empleo local ${stamp}`],
  ]) {
    const created = await page.request.post('/api/narrativas', {
      headers: { 'X-MASCLI-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin },
      data: { payload: { Fecha_Inicio: day, Tema: topic, Descripcion: `Publicación ${stamp}` } },
    });
    expect(created.ok()).toBe(true);
  }
  await page.goto('/narrativas');
  const card = page
    .getByRole('heading', { name: 'Tendencia temporal de narrativas' })
    .locator('xpath=ancestor::section[1]');
  await expect(card.locator('li').filter({ hasText: 'Medio ambiente' })).toBeVisible();
  await expect(
    card.locator('li').filter({ hasText: 'Narrativas y señales digitales' }),
  ).toBeVisible();
  await expect(card.locator('svg polyline')).toHaveCount(5);
});
