import { randomUUID } from 'node:crypto';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * rc11 visual review: on a phone the «Bandeja de alertas» table of Inteligencia de redes ran past
 * the right edge at 390 px and cut the «Revisión» column with its buttons. Each alert must show
 * every column, named, and its review button whole on the screen, with no sideways scroll of the
 * page or of a hidden region (the stacked-card pattern of Registros and Automatizaciones).
 */
for (const width of [360, 390] as const) {
  test(`the alert inbox shows every column and its review button at ${width} px`, async ({
    page,
    admin,
    adminApi,
  }) => {
    const created = await adminApi.post('/system/intelligence/territorial-alerts', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: {
        text: `tabla-movil-${randomUUID()}. Exigimos agua limpia: habrá paro y bloqueo este lunes.`,
        source_url: 'https://example.test/synthetic/tabla-movil',
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    const { id } = (await created.json()) as { id: string };
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inteligencia-redes');
    const button = page.getByRole('button', { name: `Ver alerta ${id}`, exact: true });
    await expect(button).toBeAttached();

    // Every cell and button of every row, brought to the middle of the screen by scrolling the
    // page vertically only: a point at its left and right edge must land on it, so nothing is
    // past the screen edge or clipped by a scroll region that has to be swiped first.
    const table = page.locator('table').filter({ has: button });
    const hidden = await table.evaluate((node) => {
      const problems: string[] = [];
      const targets = [...node.querySelectorAll('tbody td, tbody button')];
      for (const target of targets) {
        const before = target.getBoundingClientRect();
        window.scrollBy(0, before.top + before.height / 2 - window.innerHeight / 2);
        const box = target.getBoundingClientRect();
        // The vertical middle: a point near a rounded corner would miss a pill-shaped button.
        const y = box.top + box.height / 2;
        for (const x of [box.left + 2, box.right - 2]) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || !target.contains(hit)) {
            const name = (target.textContent ?? '').trim().slice(0, 24);
            problems.push(
              `${target.tagName.toLowerCase()} «${name}» (${Math.round(box.left)}–${Math.round(box.right)}) not shown at x ${Math.round(x)}`,
            );
            break;
          }
        }
      }
      return { problems, targets: targets.length };
    });
    expect(hidden.targets, 'rows to check').toBeGreaterThan(0);
    expect(hidden.problems, `alert inbox at ${width} px`).toEqual([]);

    // Each value shows its column's name, «Revisión» included; the name is drawn for the eye only
    // (`content: … / ''`), so a cell's accessible name stays its value and its header the column.
    const row = table.locator('tbody tr').filter({ has: button });
    const labels = await row
      .locator('td')
      .evaluateAll((cells) =>
        cells.map((cell) => getComputedStyle(cell, '::before').content.split(' / ')[0]),
      );
    expect(labels).toEqual(['"Publicación"', '"Prioridad"', '"Estado"', '"Revisión"']);
    await expect(
      row.getByRole('cell', { name: 'Pendiente de verificación', exact: true }),
    ).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      'the page does not scroll sideways',
    ).toBeLessThanOrEqual(width);

    // The review button works where it stands.
    await button.click();
    await expect(page.getByRole('heading', { level: 3, name: `Alerta ${id}` })).toBeVisible();
  });
}
