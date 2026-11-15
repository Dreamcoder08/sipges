import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { brokenWords } from '../support/text-fit.ts';

/**
 * rc2 visual review: text keeps to its own box. Runs last in the phone project because it adds
 * synthetic alerts and events to the shared project.
 */

const seed = async (
  adminApi: APIRequestContext,
  module: string,
  payload: Record<string, string>,
) => {
  const created = await adminApi.post(`/api/${module}`, {
    headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
    data: { payload },
  });
  expect(created.status(), await created.text()).toBe(200);
};

/**
 * Dashboard «Requiere atención» at 360 px (movil-inicio.png): the level pill carries the project's
 * long meaning («Naranja – Requiere intervención preventiva»); it must not spill over the alert
 * title or its date.
 */
test('a long level label stays clear of the alert title and date at 360 px', async ({
  page,
  admin,
  adminApi,
}) => {
  await seed(adminApi, 'alertas', {
    Causa: 'Bloqueo sintético de la vía de acceso',
    Nivel_Preliminar: 'Rojo',
    Fecha: '2026-10-12',
  });
  await seed(adminApi, 'alertas', {
    Causa: 'Alerta sintética por convocatoria',
    Nivel_Preliminar: 'Naranja',
    Fecha: '2026-10-11',
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/');
  const block = page.getByRole('region', { name: 'Requiere atención' });
  const rows = block.getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  // The meaning loads with the project settings; measure once it is there.
  await expect(rows.first()).toContainText('–');

  for (const row of await rows.all()) {
    const fit = await row.evaluate((item) => {
      const link = item.querySelector('a');
      const slot = link?.firstElementChild;
      const pill = slot?.firstElementChild;
      const text = link?.lastElementChild;
      if (!link || !slot || !pill || !text) throw new Error('unexpected row markup');
      const range = document.createRange();
      range.selectNodeContents(pill);
      const ink = range.getBoundingClientRect();
      const words = text.getBoundingClientRect();
      const apart =
        ink.right <= words.left ||
        words.right <= ink.left ||
        ink.bottom <= words.top ||
        words.bottom <= ink.top;
      return {
        apart,
        // The pill stays inside its slot, so it never reaches into the title column.
        slotFits: slot.scrollWidth <= slot.clientWidth,
        pillFits: pill.scrollWidth <= pill.clientWidth,
        rowFits: link.scrollWidth <= link.clientWidth,
        tall: link.getBoundingClientRect().height >= 44,
      };
    });
    expect(fit, await row.innerText()).toEqual({
      apart: true,
      slotFits: true,
      pillFits: true,
      rowFits: true,
      tall: true,
    });
    expect(await brokenWords(row)).toEqual([]);
  }
});

/**
 * Panel «Resumen del proyecto» at 360 px (movil-inicio.png, movil-hoy-completo.png): the IRSA
 * reading, its level and the methodology caveat shared one squeezed flex line, so «Riesgo IRSA
 * 6.0» and «Metodología pendiente de validación» each broke onto three lines. Each keeps to one
 * line now; the line wraps between them instead, and nothing leaves the screen.
 */
test('the IRSA reading and its caveat each keep to one line at 360 px', async ({
  page,
  admin,
  adminApi,
}) => {
  // An event with a dimension gives the IRSA evidence, so the reading shows its value.
  await seed(adminApi, 'eventos', {
    Descripcion_Hecho: 'Reunión sintética para la lectura IRSA',
    Dimension_Principal: 'G',
    Fecha: '2026-10-13',
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/');
  const lead = page.getByRole('region', { name: 'Resumen del proyecto' });
  const reading = lead.getByRole('link', { name: /^Riesgo IRSA \d/ });
  const caveat = lead.getByText('Metodología pendiente de validación');
  await expect(reading).toBeVisible();
  await expect(caveat).toBeVisible();
  // Lines the element's text occupies, measured on its glyphs with a DOM Range (icons excluded).
  // A glyph box whose middle lies below the current line's bottom starts a new line, so the
  // larger «6.0» on the same baseline does not count as a line of its own.
  const lines = (target: typeof reading) =>
    target.evaluate((root) => {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(...[...range.getClientRects()].filter((r) => r.width > 0));
      }
      rects.sort((a, b) => a.top - b.top);
      let count = 0;
      let bottom = -Infinity;
      for (const rect of rects) {
        if (rect.top + rect.height / 2 > bottom) {
          count += 1;
          bottom = rect.bottom;
        } else bottom = Math.max(bottom, rect.bottom);
      }
      return count;
    });
  const dir = process.env.SIPGES_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, 'panel-irsa-360.png') });
  expect({ reading: await lines(reading), caveat: await lines(caveat) }).toEqual({
    reading: 1,
    caveat: 1,
  });
  for (const part of [reading, caveat]) {
    const rect = await part.boundingBox();
    expect(rect && rect.x + rect.width).toBeLessThanOrEqual(360);
  }
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.view);
});

/**
 * Eventos table at a portrait tablet (tablet-eventos.png): a verification status and a long id
 * are never split mid-word; the table scrolls inside its region instead.
 */
test('the Eventos table never breaks a status or an id mid-word at 820 px', async ({
  page,
  admin,
  adminApi,
}) => {
  const stamp = String(Date.now());
  const events = [
    [`Asamblea sintética de la comunidad sobre el acta pendiente ${stamp}`, 'B - Corroborada'],
    [`Reunión sintética de seguimiento con la comunidad ${stamp}`, 'E - No verificada'],
    [`Monitoreo sintético ${stamp}`, 'C - Parcial'],
  ] as const;
  for (const [description, verification] of events) {
    await seed(adminApi, 'eventos', {
      Descripcion_Hecho: description,
      Nivel_Verificacion: verification,
      Territorio: 'Vice, Sechura',
      Fecha: '2026-10-12',
    });
  }
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/eventos');
  await page.getByLabel('Buscar registros').fill(stamp);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  const rows = page.getByRole('row').filter({ hasText: stamp });
  await expect(rows).toHaveCount(events.length);
  for (const row of await rows.all()) {
    expect(await brokenWords(row), await row.innerText()).toEqual([]);
  }
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.view);
});
