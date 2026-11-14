import { randomUUID } from 'node:crypto';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * rc8 and rc11 visual reviews: on a phone the «Bandeja de alertas» table of Inteligencia de redes
 * was wider than the screen and cut the «Revisión» column. Narrow windows stack each alert as a
 * card (intelligence-table.mobile.spec.ts checks every cell on a phone); a wide one keeps the table
 * with its four column headers. Neither scrolls the page sideways, and the review button opens the
 * alert where it stands.
 */
for (const width of [360, 390, 1280] as const) {
  test(`the alert inbox keeps «Revisión» on screen at ${width} px`, async ({
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
    const { id } = (await created.json()) as { id: string };
    await page.setViewportSize({ width, height: 844 });
    await signInToProject(page, admin, DEFAULT_SCOPE);
    await page.goto('/inteligencia-redes');
    const button = page.getByRole('button', { name: `Ver alerta ${id}`, exact: true });
    await expect(button).toBeAttached();
    // Vertical page scroll only: scrolling it into view could also swipe a table region sideways.
    await button.evaluate((node) => {
      const box = node.getBoundingClientRect();
      window.scrollBy(0, box.top + box.height / 2 - window.innerHeight / 2);
    });
    await expect(button).toBeInViewport({ ratio: 1 });

    const headers = page.getByRole('columnheader');
    if (width > 640) {
      await expect(headers.filter({ hasText: /^Revisión$/ })).toBeInViewport({ ratio: 1 });
    } else {
      // Stacked: the header row is kept for assistive technology, off screen.
      await expect(headers.filter({ hasText: /^Revisión$/ })).not.toBeInViewport();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      'the page does not scroll sideways',
    ).toBeLessThanOrEqual(width);

    await button.click();
    await expect(page.getByRole('heading', { level: 4, name: `Alerta ${id}` })).toBeVisible();
  });
}
