import type { Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Territorio must not freeze the page (world-class-local T9). Headless Chromium draws WebGL on a
 * software GPU and reads every WebGL frame back on the main thread, so GPU work shows up here as
 * long tasks: the weak-GPU case this guards.
 *
 * Measured on 2026-11-22 (12 cores, synthetic data), as longest task / total of long tasks:
 * - before the fix: the idle 3D globe re-rendered every frame, ~165 ms each (~3 s per 2 s idle),
 *   and back to 2D re-created the map: 806 ms / 3.0–3.5 s;
 * - after: idle 3D none (one ~160 ms frame in the first second after the relief settles); back
 *   to 2D at most 74 ms / 140 ms, or none once the 2D map had drawn its records.
 * The bounds leave about 4× over the measured values for slower CI runners and still fail a
 * return of either cause (one 400–800 ms re-creation task, or ~6 frames of 165 ms per second).
 */
const BACK_TO_2D = { longestMs: 400, totalMs: 600 } as const;
const IDLE_3D_TOTAL_MS = 600;

/** Long tasks since the last call, in ms; the observer is installed before the app loads. */
const drain = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    return w.__longTasks.splice(0);
  });

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/**
 * Waits until half a second passes without a long task. A layer's first draw is a one-time cost
 * of opening the map; it must be paid before the switch is measured, not counted against it.
 */
const settle = (page: Page) =>
  expect
    .poll(async () => (await drain(page)).length, { intervals: [500], timeout: 30_000 })
    .toBe(0);

test('Territorio switches between 2D and 3D without long main-thread freezes', async ({
  page,
  admin,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The Long Tasks API is Chromium-only');
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration));
    }).observe({ type: 'longtask', buffered: true });
  });
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('/mapa');
  const flat = page.locator('[data-map-engine="maplibre"]');
  await expect(flat).toBeVisible();
  const canvas = await flat.locator('canvas.maplibregl-canvas').elementHandle();
  await settle(page);

  await page.getByRole('button', { name: 'Vista 3D' }).click();
  const terrain = page.locator('[data-map-engine="cesium"]');
  await expect(terrain).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  // The globe draws only when something changes: once the relief has settled it stays idle.
  // A fixed window is the measurement itself, not a wait for state.
  await page.waitForTimeout(1_000);
  await drain(page);
  await page.waitForTimeout(2_000);
  const idle = await drain(page);
  expect(sum(idle), `idle 3D long tasks [${idle.join(', ')}] ms`).toBeLessThan(IDLE_3D_TOTAL_MS);

  await page.getByRole('button', { name: 'Vista 3D' }).click();
  await expect(flat).toBeVisible();
  await expect(terrain).toHaveCount(0);
  // The same WebGL map comes back: it stayed mounted, hidden, instead of being re-created.
  expect(await canvas?.evaluate((node) => node.isConnected)).toBe(true);
  // The 2D map's first frames, where the freeze was.
  await page.waitForTimeout(1_500);
  const back = await drain(page);
  const label = `back to 2D long tasks [${back.join(', ')}] ms`;
  expect(Math.max(0, ...back), label).toBeLessThan(BACK_TO_2D.longestMs);
  expect(sum(back), label).toBeLessThan(BACK_TO_2D.totalMs);
});
