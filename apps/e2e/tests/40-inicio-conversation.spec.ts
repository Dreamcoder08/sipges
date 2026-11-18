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
 * Inicio's conversation with the analyst at 1440×900 (odd/tasks/chat-first-ui.md T16): the
 * thread, «Detener», a new conversation, external AI off, an unavailable analyst, «Copiar», the
 * stream's step and its fallback, and the sidebar and shortcuts of the shell (T12, T14). The phone
 * companion is inicio-conversation.mobile.spec.ts. Each journey waits for state, never for time.
 */
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

const sidebar = (page: Page) => page.locator('aside').first();

test('three questions make one thread in order, and «Ir al final» returns to the end', async ({
  page,
  admin,
}) => {
  await threeQuestionThread(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('«Detener» stops a pending answer and keeps the question', async ({ page, admin }) => {
  await stopPendingAnswer(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('«Nueva conversación», Ctrl+Mayús+O and the sidebar’s «Nueva pregunta» start over', async ({
  page,
  admin,
}) => {
  await fakeAnalyst(page, { externalAi: true });
  await answerAsk(page, (question, route) =>
    route.fulfill({ json: replyTo(THREE.indexOf(question as (typeof THREE)[number]) + 1) }),
  );
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');

  // The button above the thread.
  await askAndWait(page, THREE[0], 'Respuesta sintética 1');
  await page.getByRole('button', { name: 'Nueva conversación' }).click();
  await expectEmptyInicio(page);

  // The shortcut, pressed with the focus away from the composer.
  await askAndWait(page, THREE[1], 'Respuesta sintética 2');
  await page.getByRole('button', { name: 'Copiar' }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+O');
  await expectEmptyInicio(page);

  // From another screen, the conversation is still there until «Nueva pregunta» starts over.
  await askAndWait(page, THREE[2], 'Respuesta sintética 3');
  await sidebar(page)
    .getByRole('navigation', { name: 'Secciones' })
    .getByRole('link', { name: 'Registros', exact: true })
    .click();
  await expectOtherScreen(page);
  await expect(
    sidebar(page).getByRole('region', { name: 'Conversaciones' }).getByRole('link', {
      name: THREE[2],
    }),
  ).toBeVisible();
  await sidebar(page)
    .getByRole('link', { name: /^Nueva pregunta/ })
    .click();
  await expectEmptyInicio(page);
  await expect(sidebar(page).getByRole('region', { name: 'Conversaciones' })).toHaveCount(0);
});

test('with external AI off «Preguntar» is disabled with its reason, and Buscar works', async ({
  page,
  admin,
}) => {
  await externalAiOff(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('an unavailable analyst (503) offers the search and «Volver a preguntar»', async ({
  page,
  admin,
}) => {
  await unavailableAnalyst(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('«Copiar» puts the answer and its numbered sources on the clipboard', async ({
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

test('without a stream route Inicio asks through /ask', async ({ page, admin }) => {
  await streamFallback(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('a streamed step is the pending turn’s progress text', async ({ page, admin }) => {
  await streamStep(page, (p) => signInToProject(p, admin, DEFAULT_SCOPE));
});

test('Ctrl+B hides the sidebar across a reload, and Ctrl+/ lists the shortcuts', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  const hide = page.getByRole('button', { name: 'Ocultar barra lateral' });
  const show = page.getByRole('button', { name: 'Mostrar barra lateral' });
  const stored = () => page.evaluate(() => localStorage.getItem('sipges.sidebar'));
  await expect(sidebar(page)).toBeVisible();
  await expect(hide).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('ControlOrMeta+B');
  await expect(sidebar(page)).toBeHidden();
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(stored).toBe('hidden');
  await page.reload();
  await expect(show).toBeVisible();
  await expect(sidebar(page)).toBeHidden();

  await page.keyboard.press('ControlOrMeta+B');
  await expect(sidebar(page)).toBeVisible();
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await expect(show).toHaveCount(0);
  await expect.poll(stored).toBe('shown');
  await page.reload();
  await expect(hide).toBeVisible();
  await expect(sidebar(page)).toBeVisible();

  const sheet = page.getByRole('dialog', { name: 'Atajos de teclado' });
  await page.keyboard.press('ControlOrMeta+/');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'En toda la aplicación' })).toBeVisible();
  for (const [label, keys] of [
    ['Nueva pregunta: una conversación nueva en Inicio', /^(Ctrl|⌘)\+Mayús\+O$/],
    ['Mostrar u ocultar la barra lateral (pantallas anchas)', /^(Ctrl|⌘)\+B$/],
    ['Ver los atajos de teclado', /^(Ctrl|⌘)\+\/$/],
  ] as const) {
    const row = sheet.locator('dl > div').filter({ has: page.getByRole('term').getByText(label) });
    await expect(row.getByRole('definition')).toHaveText(keys);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});
