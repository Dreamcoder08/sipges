import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/**
 * Every internal link in the content of the home screen (dashboard on desktop, «Hoy» on a
 * phone) opens a real screen: no «Página no encontrada» and a page heading.
 */
export const homeLinksJourney = async (page: Page) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const hrefs = await page
    .locator('main a[href^="/"]')
    .evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute('href') ?? ''))]);
  expect(hrefs.length, 'links on the home screen').toBeGreaterThan(0);
  for (const href of hrefs) {
    await page.goto('/');
    await page.locator(`main a[href="${href}"]`).first().click();
    await expect(page, href).toHaveURL(new RegExp(`${href.split('?')[0]}`));
    await expect(page.getByRole('heading', { level: 1 }), href).toBeVisible();
    await expect(page.getByText('Página no encontrada'), href).toHaveCount(0);
  }
};
