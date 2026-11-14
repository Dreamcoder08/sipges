import { randomUUID } from 'node:crypto';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * rc8 visual review (artefacto-territorial-intelligence-phone.png): on a phone the «Bandeja de
 * alertas» table is wider than the screen. The page itself must not scroll sideways, and the
 * cut-off «Revisión» column must stay reachable inside the table's own scroll region.
 */
for (const width of [360, 390]) {
  test(`the alert inbox table scrolls on its own at ${width} px`, async ({
    page,
    admin,
    adminApi,
  }) => {
    const created = await adminApi.post('/system/intelligence/territorial-alerts', {
      headers: { 'X-SIPGES-Scope': DEFAULT_SCOPE },
      data: {
        text: `tabla-e2e-${randomUUID()}. Exigimos agua limpia: habrá paro y bloqueo este lunes.`,
        source_url: 'https://example.test/synthetic/tabla',
      },
    });
    expect(created.status(), await created.text()).toBe(200);
    await page.setViewportSize({ width, height: 844 });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inteligencia-redes');
    const header = page.getByRole('columnheader', { name: 'Revisión', exact: true });
    await expect(header).toBeAttached();

    const geometry = await header.evaluate((cell) => {
      let region = cell.parentElement;
      while (region && !/auto|scroll/.test(getComputedStyle(region).overflowX))
        region = region.parentElement;
      if (!region) return null;
      region.scrollLeft = region.scrollWidth;
      const box = region.getBoundingClientRect();
      const end = cell.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        region: { left: box.left, right: box.right },
        cell: { left: end.left, right: end.right },
      };
    });
    expect(geometry, 'the table sits in a horizontal scroll region').not.toBeNull();
    if (!geometry) return;
    expect(geometry.page, 'the page does not scroll sideways').toBeLessThanOrEqual(
      geometry.viewport,
    );
    expect(geometry.region.right).toBeLessThanOrEqual(geometry.viewport);
    // Scrolled to its end, the region shows the whole «Revisión» column.
    expect(geometry.cell.left).toBeGreaterThanOrEqual(geometry.region.left - 1);
    expect(geometry.cell.right).toBeLessThanOrEqual(geometry.region.right + 1);
  });
}
