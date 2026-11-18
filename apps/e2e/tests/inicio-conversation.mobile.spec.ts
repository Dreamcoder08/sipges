import type { Page } from '@playwright/test';
import {
  THREE,
  answerAsk,
  askAndWait,
  expectOtherScreen,
  copyAnswer,
  expectEmptyInicio,
  externalAiOff,
  fakeAnalyst,
  replyTo,
  stopPendingAnswer,
  streamFallback,
  streamStep,
  threeQuestionThread,
  unavailableAnalyst,
} from '../support/analyst-thread.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Inicio's conversation on a phone (odd/tasks/chat-first-ui.md T16), the companion of
 * 40-inicio-conversation.spec.ts on the Pixel 7 project: the same journeys through the phone
 * layout, where «Nueva conversación» is an icon in the top row and «Nueva pregunta» lives in the
 * menu drawer. The sidebar toggle and the keyboard shortcuts are wide-screen only, so they stay
 * in the desktop spec. Each journey waits for state, never for time.
 */
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** Opens the menu drawer and waits for it to rest at the left edge. */
const openDrawer = async (page: Page) => {
  await page.getByRole('button', { name: /^Abrir menú/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Menú' });
  await expect(drawer).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
  return drawer;
};

test('phone · three questions make one thread in order, and «Ir al final» returns to the end', async ({
  page,
  admin,
}) => {
  await threeQuestionThread(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('phone · «Detener» stops a pending answer and keeps the question', async ({ page, admin }) => {
  await stopPendingAnswer(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('phone · «Nueva conversación» and the drawer’s «Nueva pregunta» start over', async ({
  page,
  admin,
}) => {
  await fakeAnalyst(page, { externalAi: true });
  await answerAsk(page, (question, route) =>
    route.fulfill({ json: replyTo(THREE.indexOf(question as (typeof THREE)[number]) + 1) }),
  );
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');

  // The icon beside the bell in the top row.
  await askAndWait(page, THREE[0], 'Respuesta sintética 1');
  await page.getByRole('button', { name: 'Nueva conversación' }).click();
  await expectEmptyInicio(page);

  // From another screen, through the menu drawer.
  await askAndWait(page, THREE[1], 'Respuesta sintética 2');
  let drawer = await openDrawer(page);
  await drawer
    .getByRole('navigation', { name: 'Secciones' })
    .getByRole('link', { name: 'Registros', exact: true })
    .click();
  await expect(drawer).toBeHidden();
  await expectOtherScreen(page);
  drawer = await openDrawer(page);
  await expect(
    drawer.getByRole('region', { name: 'Conversaciones' }).getByRole('link', { name: THREE[1] }),
  ).toBeVisible();
  await drawer.getByRole('link', { name: /^Nueva pregunta/ }).click();
  await expect(drawer).toBeHidden();
  await expectEmptyInicio(page);
});

test('phone · with external AI off «Preguntar» is disabled with its reason, and Buscar works', async ({
  page,
  admin,
}) => {
  await externalAiOff(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('phone · an unavailable analyst (503) offers the search and «Volver a preguntar»', async ({
  page,
  admin,
}) => {
  await unavailableAnalyst(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('phone · «Copiar» puts the answer and its numbered sources on the clipboard', async ({
  page,
  admin,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Only Chromium lets Playwright grant clipboard-read, which reading the copy back needs',
  );
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copyAnswer(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('phone · without a stream route Inicio asks through /ask', async ({ page, admin }) => {
  await streamFallback(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('phone · a streamed step is the pending turn’s progress text', async ({ page, admin }) => {
  await streamStep(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});
