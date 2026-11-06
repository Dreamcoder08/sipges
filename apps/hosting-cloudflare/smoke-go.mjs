// Deploy smoke test for the Go container: see src/go-smoke.ts. Run by the deploy workflow after
// /health/ready; it sends nothing while GO_ROUTES is empty.
// Needs SIPGES_SMOKE_URL: the Worker's public origin. Node must run TypeScript natively (22.18+).
import { setTimeout as sleep } from 'node:timers/promises';
import { GO_ROUTES } from './src/go-routes.ts';
import { smokeGoRoute } from './src/go-smoke.ts';

const baseUrl = process.env.SIPGES_SMOKE_URL;
if (!baseUrl) {
  console.error('SIPGES_SMOKE_URL is required');
  process.exit(1);
}

const result = await smokeGoRoute({
  routes: GO_ROUTES,
  baseUrl,
  fetcher: fetch,
  sleep: (ms) => sleep(ms),
  attempts: 6,
});

if (result.outcome === 'failed') {
  console.error(`Go route smoke test failed: GET ${result.path} (${result.last})`);
  process.exit(1);
}
console.log(
  result.outcome === 'skipped'
    ? 'No Go routes listed; nothing to probe'
    : `Go route answered the sign-in 401: GET ${result.path}`,
);
