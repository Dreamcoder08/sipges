# Testing and verification

Run `pnpm verify` from the repository root for the full local gate: lint, formatting, boundaries, types and workspace tests. Optional PostgreSQL integration is skipped unless an explicitly supplied synthetic connection is available. A focused run helps diagnosis but never replaces the gate or CI.

## Quick path

| Goal             | Command                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Full gate        | `pnpm verify`                                                                                                      |
| One API area     | `timeout 60s pnpm --filter @sipges/api exec vitest run <files> --reporter=verbose`                                 |
| One browser flow | `pnpm --filter @sipges/web build`, then `pnpm --filter @sipges/e2e exec playwright test <file> --project=chromium` |
| Tooling tests    | `pnpm test:tooling`                                                                                                |

Use explicit package `exec vitest` file filters; arguments forwarded through `pnpm test --` may not select the intended files. Always inspect the final file and test counts.

## Focus an API investigation

Tested with the normal cached runner:

```sh
timeout 60s pnpm --filter @sipges/api exec vitest run test/situations/lessons-domain.test.ts test/records/records-http.test.ts --reporter=verbose
```

If a cache issue is a specific hypothesis, compare with a bounded cache-bypass diagnostic; it is not the default fix. The earlier example and its limits are in [mature UI evidence](../odd/evidence/mature-ui/README.md); the current selection is in [reliable verification evidence](../odd/evidence/reliable-verification/README.md).

API HTTP fixtures migrate a synthetic PGlite template per test file, clone it per app, and close tracked databases after each test; the template closes after the file. Setup includes real password hashing. The suite has 106 files and uses one worker with sequential files; accumulated fixture cost is plausible but not a proven explanation for the full timeout. Per-test and hook limits stay at 20 seconds. Do not weaken isolation or security, or raise limits to obtain a green run.

## Check a browser change

Build the web app first so Playwright exercises the intended build:

```sh
pnpm --filter @sipges/web build
pnpm --filter @sipges/e2e exec playwright test tests/09-ontology-intelligence.spec.ts --project=chromium
```

The final Dialog build and the single Chromium search/360-degree flow passed, including browser hygiene under the strict CSP; matching source snapshots close the stale-build proof gap for that flow only ([command, output and snapshots](../odd/evidence/reliable-verification/README.md)). A single file is not the full browser suite.

## Vitest runner pitfalls

API and web deduplicate `vitest` through `resolve.dedupe` in [`apps/api/vitest.config.ts`](../apps/api/vitest.config.ts) and [`apps/web/vite.config.ts`](../apps/web/vite.config.ts). With pnpm, two instances of the same version with different peers can split the runner context from the one used to register hooks. Do not remove the cleanup hooks or widen timeouts to hide that failure.

Run these serially, with no other tests or builds in parallel.

**API setup** (from the root):

```bash
cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run test/config.test.ts
```

Without deduplication it fails with `Vitest failed to find the current suite` at `test/support/test-database.ts:13`: zero tests collected, exit 1. With it, the same command passes 36 tests and exits 0. Root and local Vitest were both 5.0.4, but their physical pnpm paths were different instances; Vite resolves deduplicated packages from the app root instead of the importer. The tooling test `API app-local Vitest registers shared cleanup hooks in the active runner` runs this command with a clean environment and checks the output and the absence of the context error. It needs no Git history, real data or external connections.

**Web setup** (from the root):

```bash
cd apps/web && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run src/app/navigation.test.ts
```

Without deduplication it fails registering `beforeAll` at `src/test/setup.ts:27` with `Vitest failed to find the runner`: exit 1, one failed file, zero tests. With only `resolve.dedupe: ['vitest']` it passes the six tests, including the jsdom/MSW setup, and exits 0. The tooling test `web app-local Vitest registers setup hooks in the active runner` runs the same file with the local binary and a clean environment (exit 0, one passed file, no context error or skips, without pinning the changing test total). Run it alone from the root:

```bash
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 node --test --test-name-pattern='web app-local Vitest' scripts/tooling.test.mjs
```

### Serial execution and async state in web

The web config caps `maxWorkers` at 1 and disables `fileParallelism`. Running commands one after another does not stop Vitest from running many jsdom files and loading lazy routes at once. Isolation between files is kept; timeouts are not widened and tests are not skipped. Bounded probe, from the root:

```bash
cd apps/web && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run src/app/AuditRegressions.test.tsx src/app/Evidence.test.tsx src/app/ObjectView.test.tsx src/app/RecordInsights.test.tsx src/app/Records.test.tsx src/app/Timeline.test.tsx src/features/notifications/DevicePush.test.tsx
```

The seven original files passed 48/48 with default concurrency and with `--maxWorkers=1 --no-file-parallelism`, so the probe did not reproduce the six 5-second timeouts of the 65-file gate; contention under simultaneous loading remains a hypothesis. The full web run is what shows the effect of serial execution.

`DevicePush.test.tsx` did reproduce a deterministic race when the MSW response was held until the request was seen: the request counter was already 1 but the UI still showed «Consultando suscripción del dispositivo…». The test now releases the response and waits for the final text «Los avisos push no están configurados», keeping the absent checkbox and the single request. The component, setup and wait limit are unchanged; the probe passes 48/48. It does not replace the full verification.

### API resource cleanup

```bash
cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run test/platform/test-app-lifecycle.test.ts test/platform/verify-failed-setup.test.ts
```

These five tests keep cleanup between tests, account isolation and the closing of clones whose setup fails; the `afterAll` checks also observe the closing of the last clone. Original hooks, a single worker and the 20-second limits stay. Data is synthetic and PGlite runs in memory. Node's warning about `localStorage` without `--localstorage-file` can appear in a passing run; it is not the context error. These focused checks do not replace the serial full gate of T5 in [the integration ODD](../odd/tasks/integration-consolidation.md).

## Report the outcome

Capture the command, stdout, stderr and exit code separately, including empty stderr; identify the build and the selection.

| Observation                                      | Report as            |
| ------------------------------------------------ | -------------------- |
| Successful exit and final summary for that scope | **passed**           |
| Timeout, exit 124                                | **failed (timeout)** |
| Output without a final result                    | **incomplete**       |
| Not run, including optional integrations         | **skipped**          |

Progress from earlier stages does not make the root check or CI green.

## History

The 2026-10-13 verification of the repository skills and scripts is kept in [agents-verification](history/agents-verification.md).
