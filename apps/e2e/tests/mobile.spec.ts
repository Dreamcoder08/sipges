import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { DESTINATIONS, SCREENS } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Wide tables scroll inside their own region; the page itself must never scroll sideways.
 * Compares with the layout viewport: on a touch device a too-wide page zooms out, so
 * `innerWidth` grows with it and would hide the overflow (Automatizaciones did at 622px).
 */
const expectNoHorizontalPageScroll = async (page: Page, where = 'page') => {
  const { scrollWidth, viewport } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where} wider than the viewport`).toBeLessThanOrEqual(viewport);
};

/** Axe at WCAG 2.1 AA over whatever is on screen (an open sheet included). */
const expectAccessible = async (page: Page, what: string) => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => v.id),
    `accessibility of ${what}`,
  ).toEqual([]);
};

test('mobile viewport: sign-in, menu drawer and every screen fit the width', async ({
  page,
  admin,
}) => {
  // Every screen and hub is visited at two widths; the loop outgrew the default 60 s as screens were added.
  test.setTimeout(120_000);
  await page.goto('/login');
  await expectNoHorizontalPageScroll(page);
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  await expectNoHorizontalPageScroll(page);

  // Docs/adr/0015 addendum 2026-11-01, like ChatGPT and Claude mobile: the top bar holds only the
  // menu button and the title, and there is no bottom bar.
  const header = page.getByRole('banner');
  await expect(header.getByRole('button')).toHaveCount(1);
  const menu = header.getByRole('button', { name: /^Abrir menú/ });
  const menuBox = await menu.boundingBox();
  expect(menuBox?.width).toBeGreaterThanOrEqual(44);
  expect(menuBox?.height).toBeGreaterThanOrEqual(44);
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('Inicio');
  await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toHaveCount(0);

  // The menu opens the sidebar as a drawer from the left, focused on the current destination.
  await menu.tap();
  const drawer = page.getByRole('dialog', { name: 'Menú' });
  const nav = drawer.getByRole('navigation', { name: 'Secciones' });
  await expect(nav.getByRole('link', { name: 'Inicio' })).toBeFocused();
  // It slides in from the left edge.
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
  await expectAccessible(page, 'the menu drawer');
  await expect(drawer.getByLabel('Proyecto activo')).toHaveValue(DEFAULT_SCOPE);
  await expect(drawer.getByRole('button', { name: /^Buscar/ })).toBeVisible();
  // The bell opens Bandeja › «Avisos» (functional-closure S9).
  await expect(drawer.getByRole('link', { name: /^Notificaciones/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(menu).toBeFocused();

  // Tapping the dimmed page beside the drawer closes it as well.
  await menu.tap();
  const viewport = page.viewportSize();
  await page.mouse.click((viewport?.width ?? 400) - 10, 200);
  await expect(drawer).toBeHidden();

  // Choosing a destination navigates and closes the drawer.
  await menu.tap();
  await nav.getByRole('link', { name: 'Bandeja' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'Bandeja' })).toBeFocused();
  await expect(drawer).toBeHidden();

  // The account menu at the foot of the drawer holds Configuración and sign-out.
  await menu.tap();
  await drawer.getByRole('button', { name: /^Cuenta de / }).tap();
  const account = page.getByRole('menu', { name: 'Cuenta' });
  await expect(account.getByRole('menuitem', { name: /^Configuración/ })).toBeVisible();
  await expect(account.getByRole('menuitem', { name: 'Cerrar sesión' })).toBeVisible();
  await expectAccessible(page, 'the account menu in the drawer');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // The narrowest phones in common use are 360px wide; 820px is a portrait tablet.
  for (const width of [360, 820]) {
    await page.setViewportSize({ width, height: 780 });
    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { level: 1, name: screen.title })).toBeVisible();
      await settled();
      await expectNoHorizontalPageScroll(page, `${screen.path} at ${width}px`);
    }
    for (const hub of DESTINATIONS) {
      await page.goto(hub.path);
      await expect(page.getByRole('heading', { level: 1, name: hub.label })).toBeVisible();
      await settled();
      await expectNoHorizontalPageScroll(page, `${hub.path} at ${width}px`);
    }
  }
});
