import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { watchNetwork } from '../support/network.ts';
import { smallTargets } from './target-size.ts';

/**
 * Tap targets on a phone (closure-roadmap T18): on the seven destinations at 360 px, every
 * visible control of the shell and the page is at least 44 px tall and wide (WCAG 2.5.5), except
 * links inside running text, which WCAG exempts. Set SIPGES_E2E_SCREENSHOT_DIR to also save one
 * capture per destination and theme for the owner's review.
 */
const DESTINATIONS = [
  ['inicio', '/inicio'],
  ['registros', '/registros'],
  ['bandeja', '/bandeja'],
  ['territorio', '/territorio'],
  ['analisis', '/analisis'],
  ['integraciones', '/integraciones'],
  ['configuracion', '/configuracion'],
] as const;
const MIN = 44;
const dir = process.env.SIPGES_E2E_SCREENSHOT_DIR;

for (const colorScheme of ['light', 'dark'] as const) {
  test(`every control of the seven destinations is a 44 px tap target (${colorScheme})`, async ({
    page,
    admin,
    adminApi,
  }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 360, height: 800 });
    const stamp = `${colorScheme}-${Date.now()}`;
    const actorName = `Colectivo táctil ${stamp}`;
    const created = await adminApi.post('/api/actores', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: {
        payload: {
          ID_Actor: `A-TAP-${stamp}`,
          'Nombre_Actor/Organizacion': actorName,
          Posicion_Proyecto: 'En contra',
          Territorio: 'Vice',
        },
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    await signInToProject(page, admin, DEFAULT_SCOPE);
    const settled = watchNetwork(page);
    const found: Record<string, string[]> = {};
    for (const [name, href] of DESTINATIONS) {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await settled();
      if (href === '/territorio') {
        await page
          .getByRole('list', { name: 'Registros en el mapa' })
          .getByRole('button', { name: new RegExp(actorName) })
          .click();
        await expect(page.getByRole('link', { name: actorName, exact: true })).toBeVisible();
        await settled();
      }
      const small = await smallTargets(page, MIN);
      if (small.length > 0) found[href] = small;
      // The visible screen only: a full-page capture resizes the emulated phone and drops its
      // touch pointer, so the capture would show desktop control sizes.
      if (dir) {
        await page.screenshot({
          path: `${dir}/360-${name}-${colorScheme}.png`,
          animations: 'disabled',
        });
      }
    }
    expect(found).toEqual({});
  });
}
