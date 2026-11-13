import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Bandeja › «Avisos» on a phone (functional-closure S9): the bell in the menu drawer opens the
 * tab, and nothing runs past the right edge at 360 or 412 px, in light and dark.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`Avisos fits a phone (${colorScheme})`, async ({ page, admin }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/eventos');
      await page.getByRole('button', { name: /^Abrir menú/ }).tap();
      const drawer = page.getByRole('dialog', { name: 'Menú' });
      await drawer.getByRole('link', { name: /^Notificaciones/ }).tap();
      await expect(drawer).toBeHidden();
      await expect(page).toHaveURL(/\/bandeja\?vista=avisos$/);
      await expect(page.getByRole('button', { name: 'Avisos', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const avisos = page.getByRole('region', { name: 'Avisos' });
      await expect(avisos.getByRole('heading', { level: 2, name: 'Avisos' })).toBeVisible();
      await expect(
        avisos.getByRole('link', { name: 'Configuración › Notificaciones' }),
      ).toBeVisible();
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        view: document.documentElement.clientWidth,
      }));
      expect(widths.scroll, `Avisos at ${width}px`).toBeLessThanOrEqual(widths.view);
      const mark = await avisos
        .getByRole('button', { name: 'Marcar todo como leído' })
        .boundingBox();
      expect(mark && mark.x + mark.width, `mark all at ${width}px`).toBeLessThanOrEqual(width);
      if (width === 360) {
        const axe = await analyzeAccessibility(page);
        expect(axe.violations, `Avisos (${colorScheme})`).toEqual([]);
      }
    }
  });
}
