import type { APIRequestContext, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';
import { splitPieces, widerGlyphs } from './split-pieces.ts';

/**
 * What the visit-rc13 gallery found at 360 px (odd/tasks/functional-10.md T13, F30–F31). Runs last
 * in the phone project because it adds synthetic alerts to the shared project.
 */
const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE };

const atPhone = async (page: Page, admin: { username: string; password: string }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  return settled;
};

const seedAlert = async (adminApi: APIRequestContext, payload: Record<string, string>) => {
  const created = await adminApi.post('/api/alertas', { headers, data: { payload } });
  expect(created.status(), await created.text()).toBe(200);
};

test('Auditoría at 360 px shows each operation as a card of whole words', async ({
  page,
  admin,
  adminApi,
}) => {
  // At least one operation of the project: an event created through the API.
  const created = await adminApi.post('/api/eventos', {
    headers,
    data: {
      payload: { Descripcion_Hecho: 'Evento sintético para la auditoría', Fecha: '2026-10-12' },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  // A paused rule created and deleted: two rows whose detail carries an unspaced name wider than a
  // phone card (CI: a card ran 15 px past the screen), which must break inside the card.
  const rule = await adminApi.post('/system/automations/rules', {
    headers,
    data: {
      name: 'ReglaSintéticaSinEspaciosQueNoCabeEnUnaTarjeta',
      enabled: false,
      module: 'Eventos',
      actions: ['CREATE'],
      steps: [{ kind: 'notify', title: 'Aviso sintético' }],
    },
  });
  expect(rule.status(), await rule.text()).toBe(200);
  const { id } = (await rule.json()) as { id: number };
  const removed = await adminApi.delete(`/system/automations/rules/${id}`, { headers });
  expect(removed.status(), await removed.text()).toBe(200);
  const settled = await atPhone(page, admin);
  await page.goto('/auditoria');
  const table = page.getByRole('table', { name: /Registro de operaciones/ });
  const first = table.getByRole('row').nth(1);
  await expect(first).toBeVisible();
  await settled();
  await widerGlyphs(page);
  // Every value beside its column name, inside the screen, no word split across lines.
  const firstDate = first.getByRole('cell').first();
  expect(await firstDate.evaluate((cell) => getComputedStyle(cell, '::before').content)).toContain(
    '"Fecha y hora (Lima)"',
  );
  // The label is drawn for the eye only: the cell's name stays its value, the header names it.
  await expect(table.getByRole('cell', { name: /^Fecha y hora/ })).toHaveCount(0);
  const body = table.locator('tbody tr');
  const count = Math.min(await body.count(), 12);
  for (let index = 0; index < count; index += 1) {
    const row = body.nth(index);
    expect(await splitPieces(row), await row.innerText()).toEqual([]);
    const box = await row.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  }
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.view);
});

/**
 * rc13: the project's level meaning («Rojo – Situación crítica / atención inmediata») wrapped to a
 * second line in every attention row, and with three rows those lines pushed «Esta semana» under
 * the phone composer. Each pill keeps to one line now; where «Esta semana» lands still depends on
 * how many rows (up to five) and how long their titles are, so that is checked in the gallery.
 */
test('Inicio at 360 px keeps each level pill on one line', async ({ page, admin, adminApi }) => {
  await seedAlert(adminApi, {
    Causa: 'Bloqueo sintético de la vía de acceso',
    Nivel_Preliminar: 'Rojo',
    Fecha: '2026-10-12',
  });
  await seedAlert(adminApi, {
    Causa: 'Alerta sintética por convocatoria a asamblea',
    Nivel_Preliminar: 'Naranja',
    Fecha: '2026-10-11',
  });
  const settled = await atPhone(page, admin);
  await page.goto('/inicio');
  const attention = page.getByRole('region', { name: 'Necesita tu atención' });
  const rows = attention.getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  // The meaning arrives with the project settings («Rojo – Situación crítica…»): measure then.
  await expect(attention).toContainText('–');
  await settled();
  await widerGlyphs(page);
  const pills = await attention.locator('li small > span:first-child').evaluateAll((spans) =>
    spans.map((span) => {
      const pill = span.firstElementChild ?? span;
      const style = getComputedStyle(pill);
      const lines = Math.round(pill.getBoundingClientRect().height / parseFloat(style.lineHeight));
      return { text: pill.textContent, lines, right: pill.getBoundingClientRect().right };
    }),
  );
  expect(pills.length).toBeGreaterThan(0);
  for (const pill of pills) {
    expect(pill.lines, pill.text ?? '').toBe(1);
    expect(pill.right, pill.text ?? '').toBeLessThanOrEqual(360);
  }
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(widths.page, 'Inicio wider than the screen').toBeLessThanOrEqual(widths.view);
});

test('IRSA at 360 px gives every table wider than the screen a scroll cue', async ({
  page,
  admin,
}) => {
  const settled = await atPhone(page, admin);
  await page.goto('/irsa');
  await expect(page.getByRole('table', { name: /Puntuación y disponibilidad/ })).toBeVisible();
  await settled();
  const regions = await page
    .getByRole('region', { name: /Puntuaciones por dimensión|Historial IRSA/ })
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          name: node.getAttribute('aria-label'),
          overflows: node.scrollWidth > node.clientWidth,
          cue:
            style.backgroundImage.includes('gradient') &&
            style.backgroundAttachment.includes('local'),
        };
      }),
    );
  const wide = regions.filter((region) => region.overflows);
  expect(wide.map((region) => region.name)).toContain('Puntuaciones por dimensión');
  expect(wide.filter((region) => !region.cue)).toEqual([]);
});

test('a missing page at 360 px keeps the top bar and its menu', async ({ page, admin }) => {
  await atPhone(page, admin);
  await page.goto('/pagina-que-no-existe');
  await expect(page.getByRole('link', { name: 'Volver al inicio' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Abrir menú/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Página no encontrada' })).toBeVisible();
});
