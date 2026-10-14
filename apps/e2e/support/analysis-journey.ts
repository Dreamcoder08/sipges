import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect } from './fixtures.ts';

/**
 * CSV import, links and history on a record: import two actors (review, then apply), link one
 * to the other from its card, see the link from both sides, remove it, and find the import in
 * the record history and the audit log.
 */
export const recordsExtrasJourney = async (page: Page, stamp: string) => {
  const first = `Asociación sintética ${stamp}`;
  const second = `Gremio sintético ${stamp}`;
  await page.goto('/actores');
  await page.getByRole('button', { name: 'Importar CSV' }).click();
  await expect(page.getByRole('heading', { name: 'Importar desde CSV' })).toBeFocused();
  await page.getByLabel('Archivo CSV (coma, punto y coma o tabulador)').setInputFiles({
    name: `actores-${stamp}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `Nombre del actor u organización;Tipo de actor;Territorio\n${first};Comunidad;Caleta Norte\n${second};Organización social;Caleta Sur\n`,
      'utf8',
    ),
  });
  await expect(page.getByText(`2 filas en actores-${stamp}.csv`, { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Revisar importación' }).click();
  await expect(page.getByText('Listo para importar: 2 nuevos y 0 actualizados.')).toBeVisible();
  await page.getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByText('Importación completada: 2 nuevos y 0 actualizados.')).toBeVisible();
  // Rows of the record list (the import preview table has no «Ver» buttons).
  const listRow = (text: string) =>
    page
      .getByRole('row')
      .filter({ hasText: text })
      .filter({ has: page.getByRole('button', { name: /^Ver / }) });
  const firstRow = listRow(first);
  await expect(firstRow).toContainText('Caleta Norte');
  await expect(listRow(second)).toHaveCount(1);
  const secondId = (
    (await listRow(second).getByRole('button', { name: /^Ver / }).getAttribute('aria-label')) ?? ''
  ).replace(/^Ver /, '');

  // Link the first actor to the second one from its card.
  await firstRow.getByRole('button', { name: /^Ver / }).click();
  const links = page.getByRole('form', { name: 'Nuevo vínculo' });
  await links.getByLabel('Este registro…').selectOption({ label: 'es aliado de' });
  await links.getByLabel('Tipo de registro').selectOption('actores');
  await links.getByLabel('Registro', { exact: true }).selectOption(secondId);
  await links.getByRole('button', { name: 'Vincular' }).click();
  await expect(links.getByText('Vínculo guardado.')).toBeVisible();
  const remove = page.getByRole('button', { name: `Quitar vínculo con ${second}` });
  await expect(remove).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Historial de cambios' }).getByText(/^v1 · Creación$/),
  ).toBeVisible();
  await remove.click();
  await expect(remove).toHaveCount(0);

  await page.goto('/auditoria');
  await page.getByLabel('Buscar en auditoría').fill('actores');
  await expect(page.getByRole('cell', { name: /IMPORT/ }).first()).toBeVisible();
};

/** Document lab to human decision, plus the strategic and chronology screens. */
export const analysisJourney = async (page: Page, stamp: string) => {
  await page.goto('/situacion');
  await page.getByLabel('Documento para lectura').setInputFiles({
    name: `acta-${stamp}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(
      `Acta sintética ${stamp}.\nLa comunidad presentó una demanda por acceso al agua y pidió un compromiso de monitoreo.\nSe registró una protesta pacífica en la caleta.\n`,
      'utf8',
    ),
  });
  await page.getByRole('button', { name: 'Analizar documento' }).click();
  await page.getByRole('button', { name: 'Enviar candidatos a revisión' }).click();
  await page.getByRole('button', { name: 'Actualizar bandeja' }).click();
  const finding = page
    .getByRole('article')
    .filter({ hasText: `acta-${stamp}.txt` })
    .first();
  await expect(finding).toBeVisible();
  const decision = finding.getByRole('group', { name: /^Revisar hallazgo / });
  await decision.getByLabel('Decisión').selectOption('corroborado_documentalmente');
  await decision
    .getByLabel('Nota sobre evidencia contrastada')
    .fill('Contrastado con acta firmada.');
  await decision.getByRole('button', { name: 'Guardar decisión' }).click();
  await expect(
    page.getByRole('article').filter({ hasText: 'Contrastado con acta firmada.' }).first(),
  ).toContainText('Corroborado documentalmente');
  await page.getByLabel('Filtrar estado de revisión').selectOption('corroborado_documentalmente');
  await expect(page.getByText('Contrastado con acta firmada.').first()).toBeVisible();

  // Strategic reports download as Word documents.
  await page.goto('/estrategia');
  for (const name of [
    'Descargar informe estratégico',
    'Descargar propuestas de consenso',
    'Descargar análisis integrado',
  ]) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name }).click();
    expect((await download).suggestedFilename()).toMatch(/\.docx$/);
  }

  // Chronology filters by record type: a dated event and a dated demand of this run.
  for (const [module, payload] of [
    ['eventos', { Fecha: '2026-03-02', Descripcion_Hecho: `Evento cronología ${stamp}` }],
    ['demandas', { Fecha_Registro: '2026-03-03', Descripcion: `Demanda cronología ${stamp}` }],
  ] as const) {
    const created = await page.request.post(`/api/${module}`, {
      headers: { Origin: new URL(page.url()).origin, 'X-MASCLI-Scope': DEFAULT_SCOPE },
      data: { payload },
    });
    expect(created.status(), await created.text()).toBe(200);
  }
  await page.goto('/cronologia');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Cronología territorial' }),
  ).toBeVisible();
  const types = page.getByRole('group', { name: 'Tipos de registro' });
  await expect(page.getByText(`Demanda cronología ${stamp}`)).toBeVisible();
  await types.getByLabel('Eventos').check();
  await expect(page.getByText(`Evento cronología ${stamp}`)).toBeVisible();
  await expect(page.getByText(`Demanda cronología ${stamp}`)).toHaveCount(0);
};
