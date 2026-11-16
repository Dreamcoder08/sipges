import type { CDPSession, Page } from '@playwright/test';
import { DEFAULT_SCOPE, expect, signInToProject, test } from '../support/fixtures.ts';

/**
 * Inicio usable-time budget (closure-roadmap T32, docs/testing/budgets.md).
 *
 * PROVISIONAL profile, pending T27: the real laptop's profile is not recorded yet. Until it is,
 * Chromium runs with its CPU slowed 4× and a stated network link, chosen as a plausible
 * laptop-class stand-in, not measured on the laptop. Replace PROFILE and the budget with T27's.
 */
const PROFILE = {
  name: 'provisional laptop-class (pending T27)',
  cpuSlowdown: 4,
  latencyMs: 40,
  downloadMbps: 10,
  uploadMbps: 5,
} as const;

/** Cold loads measured in one test; the budget holds their median, so one noisy load cannot fail it. */
const COLD_LOADS = 3;

/**
 * Milliseconds from navigation to a usable Inicio, for the median of COLD_LOADS. Set 2026-11-13
 * from the spread in docs/testing/budgets.md: worst medians 1.7 s on 12 cores, 2.2 s pinned to
 * two and 3.2 s pinned to one. 3 s leaves 1.4× over two cores, the smallest `ubuntu-latest` shape, and still
 * fails a 3× regression of the fastest median (1.15 s). One core is not covered: see the doc.
 */
const INICIO_USABLE_BUDGET_MS = 3_000;

const bytesPerSecond = (mbps: number) => (mbps * 1_000_000) / 8;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** One load of /inicio with an empty HTTP cache on the profile, in ms until it is usable. */
const coldLoad = async (page: Page, cdp: CDPSession) => {
  await page.goto('about:blank');
  // The service worker has no fetch handler, so it caches nothing; the HTTP cache is emptied.
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });
  const attention = page.getByRole('region', { name: 'Necesita tu atención' });
  const composer = page.getByRole('textbox', { name: /^Buscar en registros de / });
  // Generous waits, so a slow run reports its time against the budget instead of a locator timeout.
  const wait = { timeout: INICIO_USABLE_BUDGET_MS * 5 };
  const started = Date.now();
  await page.goto('/inicio', { waitUntil: 'commit' });
  await expect(attention).toBeVisible(wait);
  await expect(composer).toBeEnabled(wait);
  const elapsed = Date.now() - started;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return elapsed;
};

test('Inicio is usable within its budget on the provisional laptop-class profile', async ({
  page,
  admin,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'CPU and network throttling need the Chromium DevTools protocol',
  );
  test.setTimeout(COLD_LOADS * INICIO_USABLE_BUDGET_MS * 10 + 30_000);
  await signInToProject(page, admin, DEFAULT_SCOPE);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: PROFILE.latencyMs,
    downloadThroughput: bytesPerSecond(PROFILE.downloadMbps),
    uploadThroughput: bytesPerSecond(PROFILE.uploadMbps),
  });

  const loads: number[] = [];
  for (let n = 0; n < COLD_LOADS; n += 1) loads.push(await coldLoad(page, cdp));
  const middle = median(loads);

  const summary = `median ${middle} ms of ${loads.join(', ')} ms (${PROFILE.name}, budget ${INICIO_USABLE_BUDGET_MS} ms)`;
  test.info().annotations.push({ type: 'inicio-usable-ms', description: summary });
  console.log(`Inicio usable: ${summary}`);
  expect(middle, `Inicio became usable in a ${summary}`).toBeLessThanOrEqual(
    INICIO_USABLE_BUDGET_MS,
  );
});
