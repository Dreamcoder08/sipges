import { analyzeAccessibility } from '../support/accessibility.ts';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/*
 * Inicio's «Primeros pasos» on a new project (world-class-local T7) at the narrowest phone, light
 * and dark. The e2e project already has records and accounts, so the browser answers the record
 * counts and the account list as a new project would: no records, the administrator alone.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`the first steps fit a 360 px phone in ${colorScheme} mode`, async ({ page, admin }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme });
    await page.route('**/api/registros/summary?limit=1*', (route) =>
      route.fulfill({
        json: {
          counts: {
            eventos: 0,
            actores: 0,
            directorio: 0,
            demandas: 0,
            narrativas: 0,
            fuentes: 0,
            buzon: 0,
          },
          rows: [],
        },
      }),
    );
    await page.route('**/system/auth/accounts', (route) =>
      route.fulfill({
        json: [
          {
            username: admin.username,
            full_name: 'Persona Sintética',
            role: 'admin',
            active: 1,
            created_at: '2026-11-01T10:00:00Z',
            google_email: null,
          },
        ],
      }),
    );
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inicio');
    const steps = page.getByRole('region', { name: 'Primeros pasos' });
    await expect(steps.getByRole('listitem')).toHaveCount(2);
    await expect(steps.getByText('0 de 2')).toBeVisible();
    await expect(steps.getByRole('link', { name: 'Ir a Registros' })).toBeVisible();

    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.view);
    const hide = await steps.getByRole('button', { name: 'Ocultar' }).boundingBox();
    expect((hide?.x ?? 0) + (hide?.width ?? 0)).toBeLessThanOrEqual(360);

    const result = await analyzeAccessibility(page);
    expect(result.violations.map((v) => v.id)).toEqual([]);

    await steps.getByRole('button', { name: 'Ocultar' }).click();
    await expect(steps).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Hola/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Primeros pasos' })).toHaveCount(0);
  });
}
