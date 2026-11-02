import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Análisis › Riesgo de conflicto on a phone (docs/adr/0031, 0015): ranking, factors and back-test fit. */
const fits = async (page: Page, width: number) => {
  await page.setViewportSize({ width, height: 860 });
  const { scrollWidth, viewport } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `page wider than ${width}px`).toBeLessThanOrEqual(viewport);
  for (const control of [
    page.getByRole('button', { name: '90 días' }),
    page.getByRole('button', { name: 'Actores' }),
    page.getByRole('article').first(),
  ]) {
    const box = await control.boundingBox();
    expect(box && box.x + box.width, `right edge at ${width}px`).toBeLessThanOrEqual(width);
  }
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
};

test('conflict risk ranks a synthetic locality with linked factors and fits 360 and 412 px', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const stamp = Date.now();
  // A long synthetic name forces wrapping on narrow screens.
  const locality = `Localidad sintética de prueba con nombre largo ${stamp}`;
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  const post = async (module: string, payload: Record<string, unknown>) =>
    expect(
      (await page.request.post(`/api/${module}`, { headers, data: { payload } })).status(),
    ).toBe(200);
  await post('demandas', {
    ID_Demanda: `D-R-${stamp}`,
    Fecha_Registro: day(3),
    Territorio: locality,
    Descripcion: 'Demanda sintética de acceso a agua para riego en la parte alta',
    Prioridad: 'Alta',
  });
  await post('alertas', {
    ID_Alerta: `AL-R-${stamp}`,
    Fecha: day(1),
    Territorio: locality,
    Causa: 'Alerta sintética por convocatoria a bloqueo de vía',
    Nivel_Preliminar: 'Rojo',
    Estado: 'Abierta',
  });

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/analisis?vista=riesgo&localidad=${encodeURIComponent(locality)}`);
    const card = page.getByRole('article').filter({ hasText: locality });
    await expect(card).toBeVisible();
    await expect(card.getByText(/^Riesgo (alto|medio|bajo)$/)).toBeVisible();
    await expect(card.getByRole('link', { name: /bloqueo de vía/ }).first()).toHaveAttribute(
      'href',
      `/objeto/alertas/AL-R-${stamp}`,
    );
    await expect(page.getByRole('heading', { name: /Último back-test a 90 días/ })).toBeVisible();
    await fits(page, 360);
    await fits(page, 412);
  }
});
