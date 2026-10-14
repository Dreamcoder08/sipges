import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Visual record of the mobile shell for pull requests (odd/tasks/mobile-first-redesign.md).
 * Runs only when MASCLI_E2E_SCREENSHOT_DIR names an output folder, so the regular suite
 * never writes files: `MASCLI_E2E_SCREENSHOT_DIR=/tmp/shots pnpm e2e -- screenshots`.
 */
const dir = process.env.MASCLI_E2E_SCREENSHOT_DIR;
test.skip(!dir, 'MASCLI_E2E_SCREENSHOT_DIR is not set');

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });

test('capture the mobile shell', async ({ page, admin }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, 'movil-inicio');
  await page.getByRole('button', { name: /^Más/ }).click();
  await page.waitForTimeout(400);
  await shot(page, 'movil-mas');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.waitForTimeout(400);
  await shot(page, 'movil-cuenta');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Cambiar de proyecto/ }).click();
  await page.waitForTimeout(400);
  await shot(page, 'movil-proyecto');
  await page.keyboard.press('Escape');
  await page.goto('/alertas');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, 'movil-alertas');
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/eventos');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, 'tablet-eventos');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, 'escritorio-inicio');
  await page.getByRole('button', { name: /^Cuenta de / }).click();
  await page.waitForTimeout(400);
  await shot(page, 'escritorio-cuenta');
});
