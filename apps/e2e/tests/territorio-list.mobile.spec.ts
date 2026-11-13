import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';
import { CAPTURE_DIR, captureTerritorioMap } from '../support/territorio-capture.ts';

/**
 * Territorio › Mapa at 360 px (closure-roadmap T31, direction 03 inside Territorio): the numbered
 * list sits below the map, both stay usable with no sideways scroll, rows and the «sin ubicación»
 * action are 44 px targets, and a row and its marker select each other. The SVG renderer is forced
 * so the markers are in the DOM.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`the numbered map list works on a phone (${colorScheme})`, async ({
    page,
    admin,
    adminApi,
  }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 360, height: 800 });
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
    const first = `Asamblea en el teléfono ${stamp}`;
    const second = `Vigilia en el teléfono ${stamp}`;
    const unplaced = `Reunión sin lugar en el teléfono ${stamp}`;
    await seed(first, { Fecha: '2026-10-12', Territorio: 'Vice, Sechura' });
    await seed(second, { Fecha: '2026-10-11', Territorio: 'Bayóvar' });
    const unplacedId = await seed(unplaced, { Territorio: 'Paraje sintético sin mapa' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/territorio');

    const map = page.getByRole('region', { name: 'Mapa' });
    const list = page.getByRole('list', { name: 'Registros en el mapa' });
    const row = (title: string) => list.getByRole('button', { name: new RegExp(title) });
    await expect(row(first)).toBeVisible();
    // Phone: the list follows the map instead of sitting beside it.
    const mapBox = await map.boundingBox();
    const listBox = await list.boundingBox();
    expect(listBox && mapBox && listBox.y >= mapBox.y + mapBox.height).toBe(true);

    const n = ((await row(second).locator('span').first().textContent()) ?? '').trim();
    const secondMarker = page.getByRole('button', { name: `${n}. Eventos: ${second} (Bayóvar)` });
    await expect(secondMarker).toHaveText(n);
    await row(first).click();
    await expect(row(first)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Ficha del registro' })).toBeVisible();
    await secondMarker.focus();
    await page.keyboard.press('Enter');
    await expect(row(second)).toHaveAttribute('aria-pressed', 'true');
    await expect(row(first)).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Cerrar ficha' }).first().click();

    const group = page.getByRole('group', { name: /registro\(s\) sin ubicación/ });
    await group.locator('summary').click();
    const action = group.getByRole('link', { name: new RegExp(unplaced) });
    await expect(action).toHaveAttribute(
      'href',
      `/registros?tipo=eventos&ficha=${encodeURIComponent(`eventos.${unplacedId}`)}`,
    );
    for (const target of [row(first), row(second), group.locator('summary'), action]) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

/**
 * Opt-in capture for the owner's review: with SIPGES_SCREENSHOT_DIR set, Territorio › Mapa with
 * records at 360 px, the «sin ubicación» group open, in both themes, once with the SVG markers and
 * once with WebGL 2 left on so the canvas draws the numbers. Skipped in the regular suite.
 */
for (const renderer of ['svg', 'webgl'] as const) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`capture Territorio › Mapa with records at 360 px (${renderer}, ${colorScheme})`, async ({
      page,
      admin,
      adminApi,
    }) => {
      test.skip(!CAPTURE_DIR, 'SIPGES_SCREENSHOT_DIR is not set');
      await captureTerritorioMap(
        page,
        { admin, adminApi },
        { colorScheme, renderer, width: 360, height: 800 },
      );
    });
  }
}
