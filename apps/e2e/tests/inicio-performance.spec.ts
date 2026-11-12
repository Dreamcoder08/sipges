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

/** Milliseconds from navigation to a usable Inicio; measured locally 2026-11-12, see the doc. */
const INICIO_USABLE_BUDGET_MS = 6_000;

const bytesPerSecond = (mbps: number) => (mbps * 1_000_000) / 8;

test('Inicio is usable within its budget on the provisional laptop-class profile', async ({
  page,
  admin,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'CPU and network throttling need the Chromium DevTools protocol',
  );
  await signInToProject(page, admin, DEFAULT_SCOPE);
  await page.goto('about:blank');

  // A cold load: no HTTP cache (the service worker has no fetch handler, so it caches nothing).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: PROFILE.latencyMs,
    downloadThroughput: bytesPerSecond(PROFILE.downloadMbps),
    uploadThroughput: bytesPerSecond(PROFILE.uploadMbps),
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });

  const attention = page.getByRole('region', { name: 'Necesita tu atención' });
  const composer = page.getByRole('textbox', { name: /^Buscar en registros de / });
  // Generous waits, so a slow run reports its time against the budget instead of a locator timeout.
  const wait = { timeout: INICIO_USABLE_BUDGET_MS * 3 };
  const started = Date.now();
  await page.goto('/inicio', { waitUntil: 'commit' });
  await expect(attention).toBeVisible(wait);
  await expect(composer).toBeEnabled(wait);
  const elapsed = Date.now() - started;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  test
    .info()
    .annotations.push({ type: 'inicio-usable-ms', description: `${elapsed} (${PROFILE.name})` });
  console.log(
    `Inicio usable in ${elapsed} ms on the ${PROFILE.name} profile (budget ${INICIO_USABLE_BUDGET_MS} ms)`,
  );
  expect(
    elapsed,
    `Inicio took ${elapsed} ms to become usable on the ${PROFILE.name} profile; budget ${INICIO_USABLE_BUDGET_MS} ms`,
  ).toBeLessThanOrEqual(INICIO_USABLE_BUDGET_MS);
});
