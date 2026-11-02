import type { Page } from '@playwright/test';
import { objectJourney } from '../support/object-journey.ts';
import { homeLinksJourney } from '../support/links-journey.ts';
import { automationJourney } from '../support/automation-journey.ts';
import { analysisJourney, recordsExtrasJourney } from '../support/analysis-journey.ts';
import { adminJourney } from '../support/admin-journey.ts';
import { preventionJourney } from '../support/prevention-journey.ts';
import {
  DEFAULT_SCOPE,
  apiSession,
  createAccount,
  signInToProject,
  expect,
  test,
} from '../support/fixtures.ts';

/** /gerencia lists long ids (REV-<review item id>, plans, alerts): they wrap, never widen the page. */
const expectGerenciaFits = async (page: Page, state: string) => {
  // A record created by a review approval carries a 36-character id with no break point.
  const headers = { 'X-SIPGES-Scope': DEFAULT_SCOPE, Origin: new URL(page.url()).origin };
  const id = `REV-${crypto.randomUUID().replaceAll('-', '')}`;
  const created = await page.request.post('/api/compromisos', {
    headers,
    data: {
      payload: { ID_Compromiso: id, Descripcion: 'Compromiso sintético', Estado: 'Pendiente' },
    },
  });
  expect(created.status()).toBe(200);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/gerencia');
  await expect(page.getByText(id)).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Centro de control gerencial' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compromisos' })).toBeVisible();
  const { scrollWidth, viewport } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `/gerencia at 360px ${state}`).toBeLessThanOrEqual(viewport);
};

test('digital signal to completed preventive plan on a phone', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await preventionJourney(page, `m${Date.now()}`, DEFAULT_SCOPE);
  await expectGerenciaFits(page, 'with a plan listed');
});

test('phone · administration: accounts, Google link, projects, grants and deactivation', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await adminJourney(page, `m${Date.now()}`);
});

test('phone · CSV import, record links, history and audit trail', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await recordsExtrasJourney(page, `m${Date.now()}`);
});

test('phone · document review decision, strategic reports and chronology filters', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await analysisJourney(page, `m${Date.now()}`);
  await expectGerenciaFits(page, 'after a review approval created its record');
});

test('phone · automation rules edited, paused and removed; webhook channel added', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await automationJourney(page, `m${Date.now()}`);
});

test('phone · every link on the home screen opens a real screen', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await homeLinksJourney(page);
});

test('phone · 360° view: approve an analyst proposal and restrict a record', async ({
  page,
  admin,
  adminApi,
  baseURL,
}) => {
  const credentials = await createAccount(
    adminApi,
    { username: `lector-${Date.now()}`, role: 'consulta' },
    [DEFAULT_SCOPE],
  );
  const reader = await apiSession(baseURL ?? '', credentials);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await objectJourney(page, adminApi, reader, `m${Date.now()}`);
  await reader.dispose();
});
