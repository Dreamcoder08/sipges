import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { CAPTURE_DIR, captureTerritorioMap } from '../support/territorio-capture.ts';

/**
 * Territorio › Mapa at 1440 px (closure-roadmap T31, direction 03 inside Territorio): each record
 * on the map has a numbered row and a marker with the same number, picking either selects the
 * other, and records without a place are grouped as «sin ubicación» with a link to the Registros
 * sheet where they are completed. The SVG renderer is forced so the markers are in the DOM.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`the map lists its records with the number of their markers (${colorScheme})`, async ({
    page,
    admin,
    adminApi,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
    });
    const stamp = `${colorScheme}-${Date.now()}`;
    const seed = async (title: string, fields: Record<string, string>) => {
      const created = await adminApi.post('/api/eventos', {
        headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
        data: { payload: { Descripcion_Hecho: title, ...fields } },
      });
      expect(created.status(), await created.text()).toBe(200);
      return ((await created.json()) as { id: string }).id;
    };
    const first = `Asamblea numerada ${stamp}`;
    const second = `Vigilia numerada ${stamp}`;
    const unplaced = `Reunión sin lugar ${stamp}`;
    await seed(first, { Fecha: '2026-10-12', Territorio: 'Vice, Sechura' });
    await seed(second, { Fecha: '2026-10-11', Territorio: 'Bayóvar' });
    const unplacedId = await seed(unplaced, { Territorio: 'Paraje sintético sin mapa' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/territorio');

    const list = page.getByRole('list', { name: 'Registros en el mapa' });
    const row = (title: string) => list.getByRole('button', { name: new RegExp(title) });
    const marker = async (title: string, place: string) => {
      const n = ((await row(title).locator('span').first().textContent()) ?? '').trim();
      expect(n).toMatch(/^\d+$/);
      const found = page.getByRole('button', { name: `${n}. Eventos: ${title} (${place})` });
      await expect(found).toHaveText(n);
      return found;
    };
    const firstMarker = await marker(first, 'Vice');
    const secondMarker = await marker(second, 'Bayóvar');

    await row(first).click();
    await expect(firstMarker).toHaveAttribute('aria-pressed', 'true');
    await expect(row(first)).toHaveAttribute('aria-pressed', 'true');
    await secondMarker.focus();
    await page.keyboard.press('Enter');
    await expect(row(second)).toHaveAttribute('aria-pressed', 'true');
    await expect(row(first)).toHaveAttribute('aria-pressed', 'false');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const group = page.getByRole('group', { name: /registro\(s\) sin ubicación/ });
    await group.locator('summary').click();
    const action = group.getByRole('link', { name: new RegExp(unplaced) });
    await expect(action).toHaveAttribute(
      'href',
      `/registros?tipo=eventos&ficha=${encodeURIComponent(`eventos.${unplacedId}`)}`,
    );
    await expect(list.getByRole('button', { name: new RegExp(unplaced) })).toHaveCount(0);
    // The action leads to the record in Registros, where «Editar» completes its territory.
    await action.click();
    await expect(page.getByRole('heading', { name: `Ficha ${unplacedId}` })).toBeVisible();
  });
}

/**
 * Opt-in capture for the owner's review: with SIPGES_SCREENSHOT_DIR set, Territorio › Mapa with
 * records at 1440 px, the «sin ubicación» group open, in both themes, once with the SVG markers and
 * once with WebGL 2 left on so the canvas draws the numbers. Skipped in the regular suite.
 */
for (const renderer of ['svg', 'webgl'] as const) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`capture Territorio › Mapa with records at 1440 px (${renderer}, ${colorScheme})`, async ({
      page,
      admin,
      adminApi,
    }) => {
      test.skip(!CAPTURE_DIR, 'SIPGES_SCREENSHOT_DIR is not set');
      await captureTerritorioMap(
        page,
        { admin, adminApi },
        { colorScheme, renderer, width: 1440, height: 900 },
      );
    });
  }
}
