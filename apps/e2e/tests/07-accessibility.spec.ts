import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { SCREENS } from '../../web/src/app/navigation.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/** WCAG 2.1 A/AA rules checked by axe-core; runs after the CRUD specs, so screens hold data. */
const expectNoViolations = async (page: Page, where: string) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
  expect(summary, `accessibility violations on ${where}`).toEqual([]);
};

test('sign-in and every screen pass the automated WCAG 2.1 AA checks', async ({ page, admin }) => {
  await page.goto('/login');
  await expectNoViolations(page, '/login');
  const settled = watchNetwork(page);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  for (const screen of SCREENS) {
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { level: 1, name: screen.title })).toBeVisible();
    await settled();
    await expectNoViolations(page, screen.path);
  }
});
