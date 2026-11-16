import type { Page } from '@playwright/test';
import { DESTINATIONS, hubHref, titleFor } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Territorio and Análisis as tabbed views on a desktop (odd/tasks/workspace-architecture.md T5):
 * each view opens from `?vista=`, stays chosen after a reload, the keyboard reaches every tab, and
 * the old route stays a working deep link that the sidebar files under the same destination
 * (no redirect, like Registros and Bandeja).
 */
test.use({ viewport: { width: 1440, height: 900 } });

const HUBS = ['/territorio', '/analisis'] as const;

for (const path of HUBS) {
  const hub = DESTINATIONS.find((item) => item.path === path);
  if (!hub) throw new Error(`Unknown hub ${path}`);
  const tabsOf = (page: Page) => page.getByRole('group', { name: hub.label, exact: true });
  const tabNamed = (page: Page, label: string) =>
    tabsOf(page).getByRole('button', { name: label, exact: true });

  test(`${hub.label}: every view opens from ?vista= and survives a reload`, async ({
    page,
    admin,
  }) => {
    test.setTimeout(120_000);
    await signInToProject(page, admin, DEFAULT_SCOPE);
    for (const tab of hub.tabs) {
      const href = hubHref(hub, tab.value);
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1, name: hub.label })).toBeAttached();
      await expect(tabNamed(page, tab.label)).toHaveAttribute('aria-pressed', 'true');
      await page.reload();
      await expect(tabNamed(page, tab.label)).toHaveAttribute('aria-pressed', 'true');
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(href);
    }
  });

  test(`${hub.label}: the old routes stay deep links under the destination`, async ({
    page,
    admin,
  }) => {
    test.setTimeout(120_000);
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const nav = page.locator('aside').first().getByRole('navigation', { name: 'Secciones' });
    for (const tab of hub.tabs) {
      await page.goto(tab.screen);
      await expect(
        page.getByRole('heading', { level: 1, name: titleFor(tab.screen) }),
      ).toBeAttached();
      expect(new URL(page.url()).pathname).toBe(tab.screen);
      const link = nav.getByRole('link', { name: hub.label, exact: true });
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(link).toHaveAttribute('href', hub.path);
    }
  });

  test(`${hub.label}: the keyboard reaches every tab and Enter opens it`, async ({
    page,
    admin,
  }) => {
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto(hub.path);
    await tabNamed(page, hub.tabs[0].label).focus();
    for (const [index, tab] of hub.tabs.entries()) {
      if (index > 0) await page.keyboard.press('Tab');
      await expect(tabNamed(page, tab.label)).toBeFocused();
    }
    const last = hub.tabs[hub.tabs.length - 1] ?? hub.tabs[0];
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL((url) => url.pathname + url.search === hubHref(hub, last.value));
    await expect(tabNamed(page, last.label)).toHaveAttribute('aria-pressed', 'true');
  });
}
