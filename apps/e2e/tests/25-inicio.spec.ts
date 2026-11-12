import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';

/**
 * Inicio (odd/tasks/workspace-architecture.md T7a): composer, suggested questions and the
 * briefing at 1440×900. Set SIPGES_SCREENSHOT_DIR to also save the implementation and the
 * artboard it follows (design/workspace-architecture/01-inicio-composer.html).
 */
test.use({ viewport: { width: 1440, height: 900 } });

test('a question typed in the composer opens the global search with its text', async ({
  page,
  admin,
}) => {
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/inicio');
  await expect(page.getByRole('heading', { level: 1, name: 'Inicio' })).toBeVisible();
  const attention = page.getByRole('region', { name: 'Necesita tu atención' });
  await expect(attention).toBeVisible();
  expect((await attention.boundingBox())?.y ?? 0).toBeLessThan(
    (await page.getByRole('textbox', { name: 'Pregunta a SIPGES' }).boundingBox())?.y ?? 0,
  );
  const composer = page.getByRole('textbox', { name: 'Pregunta a SIPGES' });
  await page.getByRole('list', { name: 'Prueba con' }).getByRole('button').first().click();
  await expect(composer).not.toHaveValue('');
  await composer.fill('demandas abiertas');
  await page.getByRole('button', { name: 'Enviar pregunta' }).click();
  const palette = page.getByRole('dialog', { name: 'Búsqueda global' });
  await expect(palette.getByRole('combobox')).toHaveValue('demandas abiertas');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('captures Inicio and its artboard', async ({ page, admin }) => {
  const dir = process.env.SIPGES_SCREENSHOT_DIR;
  test.skip(!dir, 'SIPGES_SCREENSHOT_DIR is not set');
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(
    pathToFileURL(
      path.resolve(
        import.meta.dirname,
        '../../../design/workspace-architecture/01-inicio-composer.html',
      ),
    ).href + '?note=0',
  );
  await page.screenshot({ path: path.join(dir, '01-artboard.png') });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  const settled = watchNetwork(page);
  await page.goto('/inicio');
  await expect(page.getByRole('heading', { level: 2, name: /^Hola/ })).toBeVisible();
  await settled();
  await page.screenshot({ path: path.join(dir, '01-implemented.png') });
});
