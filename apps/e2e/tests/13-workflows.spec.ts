import { homeLinksJourney } from '../support/links-journey.ts';
import { automationJourney } from '../support/automation-journey.ts';
import { analysisJourney, recordsExtrasJourney } from '../support/analysis-journey.ts';
import { adminJourney } from '../support/admin-journey.ts';
import { preventionJourney } from '../support/prevention-journey.ts';
import { DEFAULT_SCOPE, signInToProject, test } from '../support/fixtures.ts';

test('digital signal to completed preventive plan on desktop', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await preventionJourney(page, `d${Date.now()}`);
});

test('administration: accounts, Google link, projects, grants and deactivation', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await adminJourney(page, `d${Date.now()}`);
});

test('CSV import, record links, history and audit trail', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await recordsExtrasJourney(page, `d${Date.now()}`);
});

test('document review decision, strategic reports and chronology filters', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await analysisJourney(page, `d${Date.now()}`);
});

test('automation rules edited, paused and removed; webhook channel added', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await automationJourney(page, `d${Date.now()}`);
});

test('every link on the home screen opens a real screen', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await homeLinksJourney(page);
});
