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
    // A marker is named after its row's number; the number itself is drawn only where it clears
    // its neighbours (engine/labels.ts), and always on the selected record's marker.
    const marker = async (title: string, place: string) => {
      const n = ((await row(title).locator('span').first().textContent()) ?? '').trim();
      expect(n).toMatch(/^\d+$/);
      const found = page.getByRole('button', { name: `${n}. Eventos: ${title} (${place})` });
      await expect(found).toHaveCount(1);
      return [found, n] as const;
    };
    const [firstMarker, firstN] = await marker(first, 'Vice');
    const [secondMarker, secondN] = await marker(second, 'Bayóvar');

    await row(first).click();
    await expect(firstMarker).toHaveAttribute('aria-pressed', 'true');
    await expect(firstMarker).toHaveText(firstN);
    await expect(row(first)).toHaveAttribute('aria-pressed', 'true');
    await secondMarker.focus();
    await page.keyboard.press('Enter');
    await expect(row(second)).toHaveAttribute('aria-pressed', 'true');
    await expect(secondMarker).toHaveText(secondN);
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
 * Territorio › Mapa at 1440 px: picking a marker selects its entry in «Evolución temporal», a
 * list far below the map. The entry is brought into view inside that list's own scroll box; the
 * page itself stays put, so the marker the person just clicked never leaves the screen.
 */
test('picking a marker at 1440 px keeps the page on the map', async ({ page, admin, adminApi }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
  });
  const stamp = Date.now();
  // Newer than the other specs' records, so all eight lead the evolution list; the oldest of
  // them, at Bernal, sits below the list's visible box.
  const places = ['Vice, Sechura', 'Bayóvar', 'Sechura', 'Parachique'];
  for (const day of [8, 7, 6, 5, 4, 3, 2]) {
    const created = await adminApi.post('/api/eventos', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: {
        payload: {
          Descripcion_Hecho: `Evolución sintética ${day} ${stamp}`,
          Territorio: places[day % places.length] ?? 'Sechura',
          Fecha: `2026-11-0${day}`,
        },
      },
    });
    expect(created.status(), await created.text()).toBe(200);
  }
  const target = `Evolución sintética antigua ${stamp}`;
  const created = await adminApi.post('/api/eventos', {
    headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
    data: { payload: { Descripcion_Hecho: target, Territorio: 'Bernal', Fecha: '2026-11-01' } },
  });
  expect(created.status(), await created.text()).toBe(200);
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/territorio');

  const row = page
    .getByRole('list', { name: 'Registros en el mapa' })
    .getByRole('button', { name: new RegExp(target) });
  const n = ((await row.locator('span').first().textContent()) ?? '').trim();
  expect(n).toMatch(/^\d+$/);
  const marker = page.getByRole('button', { name: `${n}. Eventos: ${target} (Bernal)` });
  await expect(marker).toHaveCount(1);
  // Markers of earlier runs may sit on the same spot, so the marker is picked from the keyboard,
  // which selects it through the same handler as a click.
  await marker.scrollIntoViewIfNeeded();
  await marker.focus();
  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Enter');
  await expect(marker).toHaveAttribute('aria-pressed', 'true');
  const timeline = page.getByRole('list', { name: 'Registros del periodo' });
  const entry = timeline.locator('li[data-selected="true"]');
  await expect(entry).toContainText(target);
  // The reveal runs in an effect after the selection renders; let two frames pass.
  const after = await page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY))),
      ),
  );
  const shown = await marker.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
  });
  expect({ pageMoved: after - before, markerOnScreen: shown }).toEqual({
    pageMoved: 0,
    markerOnScreen: true,
  });
  // The entry is still revealed: the list scrolled its own box down to it.
  const inList = await entry.evaluate((item) => {
    const list = item.closest('ol');
    if (!list) throw new Error('the entry sits outside its list');
    const box = list.getBoundingClientRect();
    const top = box.top + list.clientTop;
    const own = item.getBoundingClientRect();
    return {
      listScrolled: list.scrollTop > 0,
      entryShown: own.top >= top - 0.5 && own.bottom <= top + list.clientHeight + 0.5,
    };
  });
  expect(inList).toEqual({ listScrolled: true, entryShown: true });
});

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
