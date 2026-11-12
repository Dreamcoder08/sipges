import path from 'node:path';
import type { Page } from '@playwright/test';
import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Two synthetic events without a source: each one is a «Calidad de datos» pending item. */
const seed = async (page: Page, stamp: number) => {
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const titles: string[] = [];
  for (const n of [1, 2]) {
    const title = `Pendiente sintético ${n} de la bandeja ${stamp}`;
    const payload = {
      ID_Evento: `EV-B${n}-${stamp}`,
      Fecha: '2026-10-12',
      Territorio: 'Vice, Sechura',
      Descripcion_Hecho: title,
    };
    const created = await page.request.post('/api/eventos', { headers, data: { payload } });
    expect(created.status(), await created.text()).toBe(200);
    titles.push(title);
  }
  return titles;
};

/**
 * Bandeja › Pendientes at 1440 px (closure-roadmap T31 slice 6, direction 02): one 36 px row
 * per item under a sticky header, the item beside the list and named in the URL, a reload that
 * keeps it, Escape back to the list, and category filters read from `?clase=`.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`Bandeja at 1440 px: dense rows, linkable detail, Escape back to the list (${colorScheme})`, async ({
    page,
    admin,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const stamp = Date.now();
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const [, second] = await seed(page, stamp);

    // A shared filter URL opens the matching pending category.
    await page.goto('/bandeja?clase=calidad');
    const box = page.getByRole('listbox', { name: 'Pendientes de decisión' });
    await expect(box.getByRole('option').first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Filtrar pendientes' })).toHaveValue('calidad');

    const row = box.getByRole('option', { name: new RegExp(second ?? '') });
    await expect(row).toBeVisible();
    const height = (await row.boundingBox())?.height ?? 0;
    expect(height).toBeGreaterThanOrEqual(35.5);
    expect(height).toBeLessThanOrEqual(37);
    const header = page
      .getByRole('region', { name: 'Pendientes', exact: true })
      .locator('p[aria-hidden="true"]')
      .first();
    expect(await header.evaluate((node) => getComputedStyle(node).position)).toBe('sticky');
    // A mouse and keyboard: the shortcut hint is shown.
    await expect(page.getByLabel('Atajos de teclado')).toBeVisible();

    // A click selects the item, shows it beside the list and names it in the URL.
    await row.click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const detail = page.getByRole('region', { name: 'Detalle del pendiente' });
    await expect(detail.getByRole('heading', { level: 2 })).toContainText(second ?? '');
    await expect(page).toHaveURL(/pendiente=calidad%3Aeventos%2FEV-B2-/);
    const list = await page.getByRole('region', { name: 'Pendientes', exact: true }).boundingBox();
    const side = await detail.boundingBox();
    expect((list?.x ?? 0) + (list?.width ?? 0)).toBeLessThanOrEqual((side?.x ?? 0) + 1);
    const { violations } = await analyzeAccessibility(page);
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' '))}`)).toEqual([]);
    if (process.env.SIPGES_SCREENSHOT_DIR) {
      await page.screenshot({
        path: path.join(process.env.SIPGES_SCREENSHOT_DIR, `bandeja-1440-${colorScheme}.png`),
        animations: 'disabled',
      });
    }

    // A reload keeps it; Enter moves into the detail and Escape returns to the list.
    await page.reload();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(detail.getByRole('heading', { level: 2 })).toContainText(second ?? '');
    await box.focus();
    await page.keyboard.press('Enter');
    await expect(detail.getByRole('heading', { level: 2 })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(box).toBeFocused();
    await expect(page).not.toHaveURL(/pendiente=/);
    await expect(page).toHaveURL(/clase=calidad/);
  });
}
