import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/** Neighbouring Sechura localities a few kilometres apart, and how many records each gets. */
const PLACES = [
  ['Vice', 9],
  ['Bernal', 3],
  ['Bellavista de la Unión', 3],
  ['Rinconada Llicuar', 3],
  ['Cristo Nos Valga', 2],
] as const;

/**
 * Territorio › Mapa on a phone with the SVG renderer (WebGL 2 removed, so the markers are DOM
 * nodes): records of nearby localities put their markers next to each other, and the numbers
 * drawn on them must never print over one another ("17" + "16" read as "1716") nor lie under
 * another marker, as the WebGL engine already guarantees (engine/labels.ts). A marker whose number is hidden stays a button
 * named after its record.
 */
for (const width of [360, 412] as const) {
  test(`the SVG map numbers never overlap at ${width} px`, async ({ page, admin, adminApi }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 800 });
    await page.addInitScript(() => {
      delete (window as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext;
    });
    const stamp = `${width}-${Date.now()}`;
    let total = 0;
    for (const [place, count] of PLACES) {
      for (let n = 1; n <= count; n += 1) {
        const created = await adminApi.post('/api/eventos', {
          headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
          data: {
            payload: {
              Descripcion_Hecho: `Hecho sintético ${n} en ${place} ${stamp}`,
              Territorio: place,
              Fecha: `2026-10-${String(n + 1).padStart(2, '0')}`,
            },
          },
        });
        expect(created.status(), await created.text()).toBe(200);
        total += 1;
      }
    }
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/territorio');
    const markers = page.getByRole('button', { name: new RegExp(`^\\d+\\. Eventos: .*${stamp}`) });
    await expect(markers).toHaveCount(total);

    const overlaps = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('svg g[role="button"] text')]
        .filter((text) => (text.textContent ?? '').trim() !== '')
        .filter((text) => getComputedStyle(text).display !== 'none')
        .map((text) => ({
          n: (text.textContent ?? '').trim(),
          marker: text.closest('g'),
          box: text.getBoundingClientRect(),
        }))
        .filter(({ box }) => box.width > 0 && box.height > 0);
      const found: string[] = [];
      for (const { n, marker, box } of labels) {
        // Readable: no other marker is painted over the middle of the number.
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (hit?.closest('g') !== marker) found.push(`${n} under another marker`);
      }
      for (const [i, a] of labels.entries()) {
        for (const b of labels.slice(i + 1)) {
          const apart =
            a.box.right <= b.box.left ||
            b.box.right <= a.box.left ||
            a.box.bottom <= b.box.top ||
            b.box.bottom <= a.box.top;
          if (!apart) found.push(`${a.n} over ${b.n}`);
        }
      }
      return found;
    });
    expect(overlaps, `map numbers printed over each other at ${width} px`).toEqual([]);
    // Some numbers stay on the map: hiding them all would also pass the check above.
    const map = page.getByRole('group', { name: /^Mapa territorial de / });
    await expect(map.getByRole('button').locator('text').first()).toBeVisible();
  });
}
