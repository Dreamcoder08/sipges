import type { APIRequestContext } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';
import { splitPieces } from './split-pieces.ts';

/**
 * What the visit-rc13 gallery found at 1440 px (odd/tasks/functional-10.md T13, F30–F31). Runs
 * last in the desktop project because it adds an automation rule's audit rows to the shared project.
 */
const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE };

/**
 * A paused rule created and deleted: two «Automatizaciones» rows (the longest module word) whose
 * detail repeats the rule's 80-character name, so the table is wider than its column widths and
 * has to share the room out, as it did with the rc13 data.
 */
const auditAutomation = async (adminApi: APIRequestContext) => {
  const created = await adminApi.post('/system/automations/rules', {
    headers,
    data: {
      name: 'Regla sintética: la tabla de Auditoría debe dejar enteras todas sus palabras',
      enabled: false,
      module: 'Eventos',
      actions: ['CREATE'],
      steps: [{ kind: 'notify', title: 'Aviso sintético' }],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const { id } = (await created.json()) as { id: number };
  const removed = await adminApi.delete(`/system/automations/rules/${id}`, { headers });
  expect(removed.status(), await removed.text()).toBe(200);
};

test('Auditoría at 1440 px keeps every word whole («Automatizaciones», not «Automatiz / iones»)', async ({
  page,
  admin,
  adminApi,
}) => {
  await auditAutomation(adminApi);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/auditoria');
  const table = page.getByRole('table', { name: /Registro de operaciones/ });
  await expect(table.getByRole('cell', { name: 'Automatizaciones' }).first()).toBeVisible();
  expect(await splitPieces(table)).toEqual([]);
});

test('Configuración at 1440 px shows a page title above its section list', async ({
  page,
  admin,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/configuracion');
  const nav = page.getByRole('navigation', { name: 'Secciones de Configuración' });
  await expect(nav.getByRole('link', { name: 'Apariencia' })).toBeVisible();
  const title = nav.getByRole('heading', { level: 2, name: 'Configuración' });
  await expect(title).toBeInViewport();
  // A real title, not the 1 px visually hidden h1 of the shell.
  const box = await title.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(20);
});

test('a missing page at 1440 px keeps the sidebar around its notice', async ({ page, admin }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/pagina-que-no-existe');
  await expect(page.getByRole('link', { name: 'Volver al inicio' })).toBeVisible();
  await settled();
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('heading', { name: 'Página no encontrada' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Página no encontrada | SIPGES');
});
