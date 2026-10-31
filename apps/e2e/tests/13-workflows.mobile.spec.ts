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
  test,
} from '../support/fixtures.ts';

test('digital signal to completed preventive plan on a phone', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await preventionJourney(page, `m${Date.now()}`, DEFAULT_SCOPE);
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
