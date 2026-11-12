import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

const SECTIONS = [
  ['cuenta', 'Cuenta', 'Sesiones activas'],
  ['apariencia', 'Apariencia', 'Apariencia'],
  ['proyecto', 'Proyecto', 'SIPGES'],
  ['privacidad', 'Privacidad y datos', 'IA externa'],
  ['notificaciones', 'Notificaciones', 'Notificaciones'],
] as const;

/**
 * Configuración on a phone: the section list sits above the content, every section opens from
 * its own link and nothing runs past the right edge at 360 or 412 px, in light and dark.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`Configuración sections fit a phone (${colorScheme})`, async ({ page, admin }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [section, link, heading] of SECTIONS) {
        await page.goto(`/version-4?seccion=${section}`);
        const nav = page.getByRole('navigation', { name: 'Secciones de Configuración' });
        await expect(nav.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('heading', { level: 3, name: heading })).toBeVisible();
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          view: document.documentElement.clientWidth,
        }));
        expect(widths.scroll, `${section} at ${width}px`).toBeLessThanOrEqual(widths.view);
        for (const item of await nav.getByRole('link').all()) {
          const rect = await item.boundingBox();
          expect(rect && rect.x + rect.width, `${section} nav at ${width}px`).toBeLessThanOrEqual(
            width,
          );
          expect(rect?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        if (width === 360) {
          const axe = await analyzeAccessibility(page, ['wcag2a', 'wcag2aa']);
          expect(axe.violations, `${section} (${colorScheme})`).toEqual([]);
        }
      }
    }
  });
}
