import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Visual record of the mobile shell for pull requests (odd/tasks/mobile-first-redesign.md).
 * Runs only when MASCLI_E2E_SCREENSHOT_DIR names an output folder, so the regular suite
 * never writes files: `MASCLI_E2E_SCREENSHOT_DIR=/tmp/shots pnpm e2e -- screenshots`.
 */
const dir = process.env.MASCLI_E2E_SCREENSHOT_DIR;
test.skip(!dir, 'MASCLI_E2E_SCREENSHOT_DIR is not set');

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });

/** Synthetic records so the "Hoy" summary has something to show (never real data). */
const SAMPLE = {
  alertas: [
    {
      Causa: 'Bloqueo sintético de la vía de acceso',
      Nivel_Preliminar: 'Rojo',
      Fecha: '2026-10-12',
    },
    {
      Causa: 'Reclamo sintético por calidad del agua',
      Nivel_Preliminar: 'Naranja',
      Fecha: '2026-10-10',
    },
    { Causa: 'Asamblea sintética convocada', Nivel_Preliminar: 'Amarillo', Fecha: '2026-10-08' },
  ],
  eventos: [
    {
      Descripcion_Hecho: 'Reunión sintética con la comunidad',
      Dimension_Principal: 'G',
      Fecha: '2026-10-13',
    },
    {
      Descripcion_Hecho: 'Monitoreo sintético de efluentes',
      Dimension_Principal: 'E',
      Fecha: '2026-10-11',
    },
    {
      Descripcion_Hecho: 'Publicación sintética en redes',
      Dimension_Principal: 'N',
      Fecha: '2026-10-09',
    },
  ],
};

test('capture the mobile shell', async ({ page, admin, adminApi }) => {
  for (const [module, rows] of Object.entries(SAMPLE)) {
    for (const payload of rows) {
      const created = await adminApi.post(`/api/${module}`, {
        headers: { 'X-MASCLI-Scope': DEFAULT_SCOPE },
        data: { payload },
      });
      expect(created.status(), await created.text()).toBe(200);
    }
  }
  await signInToProject(page, admin, DEFAULT_SCOPE);
  // Both themes (docs/adr/0018): the dark set carries an «-oscuro» suffix.
  for (const colorScheme of ['light', 'dark'] as const) {
    const suffix = colorScheme === 'dark' ? '-oscuro' : '';
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, `movil-inicio${suffix}`);
    await page.screenshot({ path: `${dir}/movil-hoy-completo${suffix}.png`, fullPage: true });
    await page.getByRole('button', { name: /^Más/ }).click();
    await page.waitForTimeout(400);
    await shot(page, `movil-mas${suffix}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Cuenta de / }).click();
    await page.waitForTimeout(400);
    await shot(page, `movil-cuenta${suffix}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Cambiar de proyecto/ }).click();
    await page.waitForTimeout(400);
    await shot(page, `movil-proyecto${suffix}`);
    await page.keyboard.press('Escape');
    await page.goto('/alertas');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, `movil-alertas${suffix}`);
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/eventos');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, `tablet-eventos${suffix}`);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, `escritorio-inicio${suffix}`);
    await page.getByRole('button', { name: /^Cuenta de / }).click();
    await page.waitForTimeout(400);
    await shot(page, `escritorio-cuenta${suffix}`);
    await page.keyboard.press('Escape');
  }
});
