import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Compact desktop sidebar (odd/tasks/compact-sidebar.md, S1–S5): it fits a 1440×900 screen with
 * the largest section open, and the tools that used to crowd the top bar now live in it.
 * Set SIPGES_SCREENSHOT_DIR to also save the light and dark captures of /eventos.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test('the sidebar lists five destinations and Integraciones and fits without scrolling', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/gerencia');
  const sidebar = page.locator('aside').first();
  const nav = sidebar.getByRole('navigation', { name: 'Secciones' });
  for (const name of [
    'Inicio',
    'Registros',
    'Territorio',
    'Bandeja',
    'Análisis',
    'Integraciones',
  ]) {
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  }
  // Centro gerencial is a tab of Inicio, so Inicio is the current destination.
  await expect(nav.getByRole('link', { name: 'Inicio', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const overflow = await page.evaluate(() =>
    ['aside', 'aside nav'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return element.scrollHeight - element.clientHeight;
    }),
  );
  expect(overflow).toEqual([0, 0]);
  await expect(sidebar.getByRole('button', { name: /^Cuenta de / })).toBeInViewport();
});

test('search, inbox, project and account are in the sidebar, not in the top bar', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/eventos');
  const sidebar = page.locator('aside').first();
  const bar = page.locator('header').first();
  await expect(bar.getByRole('heading', { level: 1, name: 'Eventos' })).toBeVisible();
  await expect(bar.getByRole('button')).toHaveCount(0);
  await expect(bar.getByLabel('Proyecto activo')).toHaveCount(0);

  await expect(sidebar.getByLabel('Proyecto activo')).toHaveValue(DEFAULT_SCOPE);
  await expect(sidebar.getByRole('button', { name: /^Notificaciones/ })).toBeVisible();
  const search = sidebar.getByRole('button', { name: /^Buscar/ });
  await search.click();
  await expect(page.getByRole('combobox', { name: 'Buscar en todo el proyecto' })).toBeFocused();
  await page.keyboard.press('Escape');
  // The palette returns focus to its trigger after it closes; wait for that before moving focus,
  // or the late restore steals it from the account row and Enter reopens the palette.
  await expect(page.getByRole('combobox', { name: 'Buscar en todo el proyecto' })).toBeHidden();
  await expect(search).toBeFocused();

  // The account menu reaches the Sistema screens and closes with Escape.
  const account = sidebar.getByRole('button', { name: /^Cuenta de / });
  await account.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Cuenta' });
  await expect(menu.getByRole('menuitem', { name: 'Administración' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(account).toBeFocused();
  await account.click();
  await menu.getByRole('menuitem', { name: 'Configuración' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Configuración del proyecto' }),
  ).toBeVisible();
});

test('captures /eventos in light and dark', async ({ page, admin }) => {
  const dir = process.env.SIPGES_SCREENSHOT_DIR;
  test.skip(!dir, 'SIPGES_SCREENSHOT_DIR is not set');
  if (!dir) return;
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const settled = watchNetwork(page);
  await mkdir(dir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/eventos');
    await expect(page.getByRole('heading', { level: 1, name: 'Eventos' })).toBeVisible();
    await settled();
    await page.screenshot({ path: path.join(dir, `implemented-${scheme}.png`) });
  }
});
