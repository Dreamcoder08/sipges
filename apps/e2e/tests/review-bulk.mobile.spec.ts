import { analyzeAccessibility } from '../support/accessibility.ts';
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Bulk approval in the review inbox on a phone (functional-closure T26). Synthetic data only. */
const fits = async (page: Page, width: number, region: Locator) => {
  await page.setViewportSize({ width, height: 860 });
  const { scrollWidth, viewport } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `page wider than ${width}px`).toBeLessThanOrEqual(viewport);
  const box = await region.boundingBox();
  expect(box && box.x + box.width, `right edge at ${width}px`).toBeLessThanOrEqual(width);
  const axe = await analyzeAccessibility(page);
  expect(axe.violations.map((v) => v.id)).toEqual([]);
};

test('approves selected review items after the preview and fits 360 and 412 px', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const theme = `Tema sintético lote ${Date.now()}`;
  const imported = await page.request.post('/system/document-lab/review/import', {
    headers,
    data: {
      filename: 'acta-lote-sintetica.txt',
      sha256: 'e'.repeat(64),
      items: [1, 2, 3].map((n) => ({
        tema: theme,
        ubicacion: `Línea ${n}`,
        fragmento: `Fragmento sintético de lote número ${n}.`,
        accion_sugerida: 'Contrastar con el acta sintética.',
      })),
    },
  });
  expect(imported.status()).toBe(200);

  await page.goto('/situacion');
  const inbox = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Bandeja de revisión documental' }),
  });
  await inbox.getByLabel('Filtrar tema').selectOption(theme);
  const bar = inbox.getByRole('group', { name: 'Decisión en lote' });
  await expect(bar.getByRole('button', { name: 'Aprobar seleccionados (0)' })).toBeDisabled();

  // Keyboard only: tick «Seleccionar todos los visibles», untick one, open the confirmation.
  await bar.getByRole('checkbox', { name: 'Seleccionar todos los visibles' }).focus();
  await page.keyboard.press('Space');
  await inbox
    .getByRole('checkbox', { name: 'Seleccionar hallazgo Línea 3 de acta-lote-sintetica.txt' })
    .focus();
  await page.keyboard.press('Space');
  const approve = bar.getByRole('button', { name: 'Aprobar seleccionados (2)' });
  await approve.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('alertdialog', { name: 'Aprobar en lote' });
  await expect(dialog).toContainText('Se aprobarán 2 hallazgos pendientes seleccionados');
  await expect(dialog).toContainText('se crearán 2 registros: Hechos compartidos 2.');
  for (const width of [360, 412]) await fits(page, width, dialog);
  await dialog.getByRole('button', { name: 'Aprobar 2' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    inbox.getByText('Se decidieron 2 hallazgos y se crearon 2 registros.'),
  ).toBeVisible();
  await expect(
    inbox.getByRole('link', { name: 'Ver el registro en Hechos compartidos' }),
  ).toHaveCount(2);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [360, 412]) await fits(page, width, bar);
  }
});
