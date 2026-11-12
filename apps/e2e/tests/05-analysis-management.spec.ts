import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Download, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const download = async (page: Page, button: string): Promise<{ file: Download; bytes: Buffer }> => {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button }).click();
  const file = await pending;
  return { file, bytes: await readFile((await file.path()) ?? '') };
};

test.beforeEach(async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
});

test('IRSA computes the index and stores a snapshot in the history', async ({ page }) => {
  await page.goto('/irsa');
  await expect(page.getByRole('heading', { level: 1, name: 'IRSA-SIPGES' })).toBeVisible();
  // One caveat next to the value; the methodology waits behind «Cómo se calcula».
  await expect(page.getByText('Metodología pendiente de validación')).toHaveCount(1);
  await expect(page.getByText('Metodología pendiente de validación')).toBeVisible();
  const status = page.getByText('PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS');
  await expect(status).toBeHidden();
  await page.getByText('Cómo se calcula').click();
  await expect(status).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Puntuación y disponibilidad por dimensión' }),
  ).toBeVisible();

  const note = `Corte sintético E2E ${Date.now()}`;
  await page.getByLabel('Nota del corte').fill(note);
  await page.getByRole('button', { name: 'Guardar corte IRSA' }).click();
  await expect(
    page
      .getByRole('table', { name: 'Últimos 50 cortes del proyecto' })
      .getByRole('cell', { name: note }),
  ).toBeVisible();
});

test('situational and strategic analyses render and download DOCX reports', async ({ page }) => {
  await page.goto('/situacion');
  await expect(page.getByRole('heading', { level: 1, name: 'Análisis situacional' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Estado del proyecto' })).toBeVisible();
  const situational = await download(page, 'Descargar informe situacional');
  expect(situational.file.suggestedFilename()).toMatch(/\.docx$/);
  expect(situational.bytes.subarray(0, 4)).toEqual(ZIP_SIGNATURE);

  await page.goto('/estrategia');
  await expect(page.getByRole('heading', { name: 'Evaluación estratégica' })).toBeVisible();
  for (const button of [
    'Descargar informe estratégico',
    'Descargar propuestas de consenso',
    'Descargar análisis integrado',
  ]) {
    const report = await download(page, button);
    expect(report.file.suggestedFilename()).toMatch(/\.docx$/);
    expect(report.bytes.subarray(0, 4)).toEqual(ZIP_SIGNATURE);
  }
});

test('document lab reads a file, downloads its report and sends candidates to review', async ({
  page,
}) => {
  const text = [
    'Acta sintética de reunión territorial.',
    'La comunidad presentó una demanda por acceso al agua y pidió un compromiso de monitoreo.',
    'Se registró un conflicto por la pesca artesanal y una protesta pacífica en la caleta.',
    'La empresa ofreció diálogo y mesa de trabajo con la municipalidad.',
  ].join('\n');
  const buffer = Buffer.from(text, 'utf8');
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  await page.goto('/situacion');
  await page
    .getByLabel('Documento para lectura')
    .setInputFiles({ name: 'acta-lab.txt', mimeType: 'text/plain', buffer });
  await page.getByRole('button', { name: 'Analizar documento' }).click();
  await expect(page.getByText(`SHA-256: ${sha256}`)).toBeVisible();
  await expect(page.getByText(/^acta-lab\.txt · \d+ secciones · \d+ candidatos$/)).toBeVisible();

  const report = await download(page, 'Descargar lectura documental');
  expect(report.file.suggestedFilename()).toMatch(/\.docx$/);
  expect(report.bytes.subarray(0, 4)).toEqual(ZIP_SIGNATURE);

  // Candidates go to the human review inbox; they never become facts automatically.
  await expect(
    page.getByText(/^acta-lab\.txt · \d+ secciones · [1-9]\d* candidatos$/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Enviar candidatos a revisión' }).click();
  await page.getByRole('button', { name: 'Actualizar bandeja' }).click();
  await expect(page.getByText(/^[1-9]\d* hallazgos en la bandeja del proyecto\.$/)).toBeVisible();
});

test('management center shows project metrics and downloads the CSV report', async ({ page }) => {
  await page.goto('/gerencia');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Centro de control gerencial' }),
  ).toBeVisible();
  await expect(page.getByText(/^Proyecto: PRJ-SECHURA · Generado: /)).toBeVisible();
  const csv = await download(page, 'Descargar CSV');
  expect(csv.file.suggestedFilename()).toBe('sipges_rc28_reporte_gerencial.csv');
  const content = csv.bytes.toString('utf8').replace(/^\uFEFF/, '');
  expect(content.split(/\r?\n/).length).toBeGreaterThan(1);
  expect(content).toContain('PRJ-SECHURA');
  expect(content).not.toContain('PRJ-NORTE');
});
