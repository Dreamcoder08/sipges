import type { Locator, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { fakeAnalyst } from '../support/analyst-thread.ts';
import { smallTargets } from './target-size.ts';

/*
 * Inicio's conversation on a phone (odd/tasks/chat-first-ui.md T15, the phone frames of
 * design/chat-first/01-centro-conversacional.html): the thread fills the screen, the composer
 * stays docked above the bottom safe area, and the menu drawer holds «Nueva pregunta» and the
 * session's questions, every control a 44 px target. This e2e API has no analyst, so the
 * browser answers with a synthetic reply and the project settings say external AI is on.
 */
const QUESTION = '¿Qué pasa con la comunidad sintética del valle alto?';
const reply = {
  answer: 'La comunidad sintética mantiene abierta la mesa de diálogo [1].',
  sources: [{ n: 1, module: 'actores', id: 'A-SINTETICO-0101', title: 'Comunidad sintética' }],
  blocks: [],
};

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error('element has no box');
  return rect;
};

const askOnPhone = async (page: Page, admin: { username: string; password: string }) => {
  await fakeAnalyst(page, { externalAi: true });
  await page.route('**/system/analyst/ask', (route) => route.fulfill({ json: reply }));
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  const field = page.getByRole('textbox', { name: 'Preguntar, con citas' });
  await field.fill(QUESTION);
  await field.press('Enter');
  await expect(
    page
      .getByRole('region', { name: 'Respuesta del analista' })
      .getByRole('link', { name: /^Fuente 1:/ }),
  ).toBeVisible();
  // The answer empties the box: the conversation is at rest.
  await expect(field).toHaveValue('');
};

for (const width of [360, 412] as const) {
  test(`during a conversation a ${width} px phone gives the screen to the thread`, async ({
    page,
    admin,
  }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await askOnPhone(page, admin);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    // The greeting gives way to the thread (it stays in the outline for screen readers).
    const greeting = await box(page.getByRole('heading', { name: /^Hola/ }));
    expect(greeting.height, 'the greeting is not drawn').toBeLessThanOrEqual(1);

    // «Nueva conversación» waits beside the bell in the top row, not on a row of its own.
    const bell = await box(
      page.getByRole('button', { name: /^Necesita tu atención|^Nada urgente/ }),
    );
    const fresh = await box(page.getByRole('button', { name: 'Nueva conversación' }));
    expect(Math.abs(fresh.y + fresh.height / 2 - (bell.y + bell.height / 2))).toBeLessThanOrEqual(
      2,
    );

    // The thread starts in the top third of the screen and runs down to the docked composer.
    const log = await box(page.getByRole('log', { name: 'Conversación con el analista' }));
    expect(log.y, 'the thread starts near the top').toBeLessThanOrEqual(780 * 0.3);
    const composer = await box(page.locator('form[data-ai]'));
    expect(
      780 - (composer.y + composer.height),
      'the composer rests on the bottom',
    ).toBeLessThanOrEqual(24);

    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(widths.scroll, 'no sideways scroll').toBeLessThanOrEqual(widths.view);
    expect(await smallTargets(page, 44), 'every control is a 44 px target').toEqual([]);
  });
}

test('the phone menu holds «Nueva pregunta» and the conversation, as 44 px targets', async ({
  page,
  admin,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await askOnPhone(page, admin);

  await page.getByRole('button', { name: /^Abrir menú/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Menú' });
  await expect(drawer).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
  await expect(drawer.getByRole('link').first()).toHaveAccessibleName(/^Nueva pregunta/);
  await expect(
    drawer.getByRole('region', { name: 'Conversaciones' }).getByRole('link', { name: QUESTION }),
  ).toBeVisible();
  expect(await smallTargets(page, 44), 'every control of the menu is a 44 px target').toEqual([]);

  // «Nueva pregunta» closes the menu and starts over in the composer.
  await drawer.getByRole('link', { name: /^Nueva pregunta/ }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('log', { name: 'Conversación con el analista' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Preguntar, con citas' })).toBeFocused();
});

/**
 * A phone with a home indicator reports a bottom safe area: the docked composer stays above it,
 * empty and during a conversation (`env(safe-area-inset-bottom)`, emulated through CDP).
 */
test('the docked composer stays above a phone’s bottom safe area', async ({ page, admin }) => {
  const inset = 34;
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send(
    'Emulation.setSafeAreaInsetsOverride' as never,
    {
      insets: { top: 0, left: 0, right: 0, bottom: inset },
    } as never,
  );
  await askOnPhone(page, admin);
  const composer = page.locator('form[data-ai]');
  for (const top of [0, 1e6]) {
    await page.evaluate((y) => window.scrollTo(0, y), top);
    const rect = await box(composer);
    expect(rect.y + rect.height, `clear of the safe area at scroll ${top}`).toBeLessThanOrEqual(
      780 - inset,
    );
    expect(780 - inset - (rect.y + rect.height), 'still resting on it').toBeLessThanOrEqual(24);
  }
});
