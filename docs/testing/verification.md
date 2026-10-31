# Verification and focused diagnostics

Run `pnpm verify` from the repository root for the full local gate. It runs lint, formatting, boundaries, types and workspace tests; optional PostgreSQL integration is skipped unless an explicitly supplied synthetic connection is available. A focused run is useful for diagnosis, but is not a substitute for the gate or CI.

## Focus an API investigation

From the root, this exact bounded selection was tested with the normal cached runner:

```sh
timeout 60s pnpm --filter @mascli/api exec vitest run test/situations/lessons-domain.test.ts test/records/records-http.test.ts --reporter=verbose
```

Use explicit package `exec vitest` file filters rather than assuming arguments forwarded through `pnpm test --` select the intended files. Inspect the final file and test counts. If a cache issue is a specific hypothesis, compare with a bounded cache-bypass diagnostic; it is not the default fix. The earlier example and its limitations are in [mature UI evidence](../../odd/evidence/mature-ui/README.md); the current selection is in [reliable verification evidence](../../odd/evidence/reliable-verification/README.md).

API HTTP fixtures migrate a synthetic PGlite template per test file, clone it per app, and close tracked databases after each test; the template closes after the file. Setup includes real password hashing. The suite has 106 files and currently uses one worker with sequential files; accumulated fixture cost is plausible but not a proven explanation for the full timeout. Per-test and hook limits remain 20 seconds. Do not weaken isolation or security, or arbitrarily increase limits to obtain a green run.

## Check a browser change

Build the web app before a focused browser run so Playwright exercises the intended build:

```sh
pnpm --filter @mascli/web build
pnpm --filter @mascli/e2e exec playwright test tests/09-ontology-intelligence.spec.ts --project=chromium
```

The exact final Dialog build and single Chromium search/360-degree flow passed, including browser hygiene under the existing strict CSP. Matching source snapshots close the stale-build proof gap for that flow only; see the [command, output and snapshots](../../odd/evidence/reliable-verification/README.md). A single file is not the full browser suite.

## Report the outcome

Capture the command, stdout, stderr and exit code separately, including empty stderr; identify the build and selection. Report **passed** only with a successful exit and final summary for that scope. A timeout exit 124 is **failed (timeout)**, not a pass; output without a final result is **incomplete**. Mark tests not run, including optional integrations, **skipped**, not passed. Progress from earlier stages does not make the root check or CI green.
