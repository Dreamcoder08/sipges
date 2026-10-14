import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { SCREENS } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/** Wide tables scroll inside their own region; the page itself must never scroll sideways. */
const expectNoHorizontalPageScroll = async (page: Page) => {
  const { scrollWidth, viewport } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(scrollWidth, 'page wider than the viewport').toBeLessThanOrEqual(viewport);
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

test('mobile viewport: sign-in, bottom bar, sheets and every screen fit the width', async ({
  page,
  admin,
}) => {
  await page.goto('/login');
  await expectNoHorizontalPageScroll(page);
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard ejecutivo' })).toBeVisible();
  await expectNoHorizontalPageScroll(page);

  // Docs/adr/0015 R1: the phone header holds only the project context, search and account.
  const header = page.getByRole('banner');
  await expect(header.getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Salir' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toHaveCount(0);

  // R2: five destinations at the bottom, each at least 44 px square.
  const bar = page.getByRole('navigation', { name: 'Navegación principal' });
  await expect(bar.getByRole('listitem')).toHaveText([
    'Inicio',
    'Monitoreo',
    'Alertas',
    'Territorio',
    'Más',
  ]);
  for (const box of await bar
    .getByRole('listitem')
    .evaluateAll((items) => items.map((item) => item.firstElementChild?.getBoundingClientRect()))) {
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(bar.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
  await bar.getByRole('link', { name: 'Alertas' }).tap();
  await expect(page.getByRole('heading', { level: 1, name: 'Centro de alertas' })).toBeFocused();
  await expect(bar.getByRole('link', { name: 'Alertas' })).toHaveAttribute('aria-current', 'page');

  // R3/R4: "Más" opens a sheet; Escape closes it and focus returns to the tab.
  const more = bar.getByRole('button', { name: 'Más' });
  await more.tap();
  const sheet = page.getByRole('dialog', { name: 'Más secciones' });
  const nav = sheet.getByRole('navigation', { name: 'Secciones' });
  await expect(nav.getByRole('link', { name: 'Actores' })).toBeFocused();
  await expectAccessible(page, 'the "Más" sheet');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  // Tapping the dimmed page above the sheet closes it as well.
  await more.tap();
  await page.mouse.click(10, 10);
  await expect(sheet).toBeHidden();

  await more.tap();
  await nav.getByRole('link', { name: 'Demandas' }).tap();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Demandas y compromisos' }),
  ).toBeFocused();
  await expect(sheet).toBeHidden();
  await expect(bar.getByRole('button', { name: /^Más.*Demandas/ })).toHaveAttribute(
    'data-active',
    'true',
  );

  // R5: the account sheet holds the inbox and sign-out.
  await page.getByRole('button', { name: /^Cuenta de / }).tap();
  const account = page.getByRole('dialog', { name: 'Cuenta' });
  await expect(account.getByText('Notificaciones', { exact: true })).toBeVisible();
  await expect(account.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  await expectAccessible(page, 'the account sheet');
  await page.keyboard.press('Escape');

  // R6: the project sheet holds the selector.
  await page.getByRole('button', { name: /Cambiar de proyecto/ }).tap();
  await expect(
    page.getByRole('dialog', { name: 'Cambiar de proyecto' }).getByLabel('Proyecto activo'),
  ).toHaveValue(DEFAULT_SCOPE);
  await page.keyboard.press('Escape');

  // The narrowest phones in common use are 360px wide.
  await page.setViewportSize({ width: 360, height: 780 });
  for (const screen of SCREENS) {
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { level: 1, name: screen.title })).toBeVisible();
    await settled();
    await expectNoHorizontalPageScroll(page);
  }
});
