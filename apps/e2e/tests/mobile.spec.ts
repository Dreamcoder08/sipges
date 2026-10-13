import type { Page } from '@playwright/test';
import { SCREENS } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Wide tables scroll inside their own region; the page itself must never scroll sideways. */
const expectNoHorizontalPageScroll = async (page: Page) => {
  const { scrollWidth, viewport } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(scrollWidth, 'page wider than the viewport').toBeLessThanOrEqual(viewport);
};

test('mobile viewport: sign-in, menu navigation and every screen fit the width', async ({
  page,
  admin,
}) => {
  await page.goto('/login');
  await expectNoHorizontalPageScroll(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard ejecutivo' })).toBeVisible();
  await expectNoHorizontalPageScroll(page);

  const toggle = page.getByRole('button', { name: 'Abrir menú' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Cerrar menú' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await page
    .getByRole('navigation', { name: 'Secciones' })
    .getByRole('link', { name: 'Eventos' })
    .tap();
  await expect(page.getByRole('heading', { level: 1, name: 'Eventos' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Eventos' })).toBeFocused();

  for (const screen of SCREENS) {
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { level: 1, name: screen.title })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalPageScroll(page);
  }
});
