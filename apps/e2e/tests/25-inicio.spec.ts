import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Inicio (closure-roadmap T31): attention first, an honestly labelled composer and the
 * briefing at 1440×900. Set SIPGES_SCREENSHOT_DIR to capture both implementation themes.
 * The approved design/vanguard artboard is maintained separately from the application branch.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test('a question typed in the composer opens the global search with its text', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  // External AI is off by default (ADR 0030): the composer says it searches the records.
  const composer = page.getByRole('textbox', { name: /^Buscar en registros de / });
  // What needs attention comes first; the composer sits below it.
  const attention = page.getByRole('region', { name: 'Necesita tu atención' });
  await expect(attention).toBeVisible();
  await expect(page.getByText('IA externa desactivada')).toBeVisible();
  expect((await attention.boundingBox())?.y ?? 0).toBeLessThan(
    (await composer.boundingBox())?.y ?? 0,
  );
  await page.getByRole('list', { name: 'Prueba con' }).getByRole('button').first().click();
  await expect(composer).not.toHaveValue('');
  await composer.fill('demandas abiertas');
  await page.getByRole('button', { name: 'Buscar en registros' }).click();
  const palette = page.getByRole('dialog', { name: 'Búsqueda global' });
  await expect(palette.getByRole('combobox')).toHaveValue('demandas abiertas');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('Inicio says so while the browser is offline', async ({ page, admin }) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  await expect(page.getByRole('region', { name: 'Necesita tu atención' })).toBeVisible();
  const offline = page.getByText('Sin conexión · lo que ves puede no estar al día');
  await expect(offline).toHaveCount(0);
  await page.context().setOffline(true);
  await expect(offline).toBeVisible();
  await page.context().setOffline(false);
  await expect(offline).toHaveCount(0);
});

test('captures Inicio in both themes', async ({ page, admin }) => {
  const dir = process.env.SIPGES_SCREENSHOT_DIR;
  test.skip(!dir, 'SIPGES_SCREENSHOT_DIR is not set');
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const settled = watchNetwork(page);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/inicio');
    await expect(page.getByRole('heading', { level: 2, name: /^Hola/ })).toBeVisible();
    await settled();
    await page.screenshot({ path: path.join(dir, `inicio-1440-${colorScheme}.png`) });
  }
});
