# Processing benchmarks (T12)

ADR 0005 allows a Go or Rust adapter only when a benchmark justifies it. The gate trips when,
after algorithmic fixes and at 10× the current data volume:
- p95 latency exceeds 500 ms, or
- a CPU-bound task blocks the event loop for more than 50 ms and worker threads cannot solve it.

**Historical result (2026-10-13): the gate did not trip.** Four fixes brought every 10×
scenario under both limits on that environment:
- two algorithmic fixes (candidate links and finding comparison);
- one PDF worker thread;
- one parallel embedding call.

No second language is added.

**Current local result (2026-10-24): the full synthetic run completed, but dashboard and
IRSA exceeded 50 ms loop block at 10× on embedded PGlite (86.10 / 64.44 ms).** Their
p95 values were 86.43 / 63.84 ms, below 500 ms. This is not a comparable PostgreSQL-server
regression or justification for a native adapter. See [T6 evidence and limits](../../odd/evidence/t6-benchmark/README.md)
and [the 36-scenario result JSON](../../odd/evidence/t6-benchmark/full.json).

## Dashboard projection candidate (local, not a production gate)

The first [production-candidate slice](../../odd/tasks/production-candidate.md) keeps the
summary engine and generic analytics reader unchanged. Only dashboard uses a dedicated SQL
projection: row IDs and module names, raw JSON `Estado` for Demandas/Alertas and raw JSON
`Nivel_Preliminar`/`Nivel` for Alertas. Count-only modules return empty payloads. Ordering,
`withTenant`, the non-owner role, forced-RLS catalog check and clearance policy remain in
place; classification is evaluated on the stored row, not the projected payload. Missing
keys become JSON null, equivalent for this engine's status and truthiness fallbacks.

A transient in-memory PGlite comparison seeded `syntheticRecords(10)` (seed 42), all 4,840
records, through the migrated schema with one synthetic tenant. Both readers ran on the
same database: three warm-ups each, then ten interleaved samples, reversing reader order
every sample. Timing covers `reader.read`, including tenant transaction and catalog check;
JSON byte counting and summary calculation are outside timing. No files or external database
were used. Results below serialize the returned `RecordsByModule`, **not wire bytes**:

| Observation | Generic reader | Dashboard projection |
| --- | --- | --- |
| Returned rows | 3,580 | 3,580 |
| Returned records JSON bytes (UTF-8) | 1,684,873 | 169,590 |
| Reader p50 (5th sorted sample of 10) | 49.24 ms | 29.59 ms |
| Reader p95 (10th sorted sample of 10) | 58.68 ms | 34.53 ms |

Both summaries were byte-identical (191 bytes). Returned records JSON fell by 89.93%; row
count did not change. These local timing samples show no reader latency regression in this
run, but do not isolate SQL CPU cost or establish PostgreSQL-server/load performance. The
historical baselines below are unchanged. A base-commit HTTP differential and the broader
candidate gates remain separate evidence owned by T4.

Focused regression (app-local runner, no persisted transform cache):

```bash
cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run test/analytics/dashboard-projection.test.ts test/analytics/dashboard-app.test.ts --no-fs-module-cache
```

Projection tests pin raw JSON types, row order, irrelevant-field removal and forced-RLS
refusal. Composed HTTP tests pin all counters, falsy level fallback, Python-style coercion,
closed states, a full-payload sibling analysis, tenant rejection without state changes, and
the existing clearance distinction (`consulta` limited; `analista`/`coordinador` full).
These tests establish behavior, not latency.

## Method

- Harness: `apps/api/bench/run.ts`. Each scenario runs after a warm-up (30 runs; 10 for PDF
  and cold semantic analysis). It reports p50, p95 and max latency, plus the longest event-loop
  stall measured with `monitorEventLoopDelay`.
- Data: `apps/api/bench/synthetic.ts` generates deterministic synthetic records with the legacy
  field names and a fixed vocabulary. No operational data is used.
- 1× is the legacy installation's record counts (397 records), plus 20 records in each RC 1.7
  module, which are empty in the legacy seed: 484 records in total. 10× is 4,840 records and
  100× is 48,400 (stress only).
- Documents use the lab's limits: a 100-page PDF of 40 lines per page, two such documents for
  the comparison, and a document with no theme words as the slowest scan.
- Semantic analysis uses a model double that answers after 40 ms, so it measures orchestration
  and not model speed.
- HTTP scenarios go through the full Hono app with the session and tenancy middleware, reading
  4,840 records from **real PostgreSQL 16** (`SIPGES_BENCH_DATABASE_URL`). Without that
  variable the harness uses embedded PGlite, whose queries run on the event loop.
- The HTTP fixture (`apps/api/bench/http-session.ts`) creates a disposable synthetic admin,
  logs in, enrolls TOTP through the public setup/enable endpoints, and selects the granted
  `SIPGES/PRJ-SECHURA` project through `/select-project`. Both session and scope cookies are
  carried on measurements. MFA, role and tenant middleware remain enabled; enrollment and
  project selection are setup costs, outside the timed GETs. Secrets and cookies are not
  printed. Any non-200 GET aborts the run rather than counting a denial as latency.
- `test/analytics/benchmark-session.test.ts` exercises that same fixture against isolated
  in-memory PGlite and every declared HTTP scenario, including denial/error handling. It is
  a functional regression, not a latency baseline or a real PostgreSQL measurement.
- Hardware for the historical results below: Intel Xeon @ 2.10 GHz, 4 cores, 16 GiB.
  Node 22.22.0.

```bash
corepack pnpm --filter @sipges/api bench                     # full run, embedded PGlite
SIPGES_BENCH_DATABASE_URL=postgres://… corepack pnpm --filter @sipges/api bench -- --out r.json
corepack pnpm --filter @sipges/api bench -- --quick          # 1× and 10× only, fewer runs
```

Raw results: `results/2026-10-13-baseline.json` (before) and `results/2026-10-13-after.json`.

## Findings and fixes

| Hotspot (10× unless noted) | Before p95 / loop block | After p95 / loop block | Fix |
| --- | --- | --- | --- |
| Candidate links | 626 ms / 840 ms | 1.3 ms / 1.4 ms | Terms and link keys computed once per record, not per pair; stop at the 120-pair cap |
| Integrated analysis | 627 ms / 737 ms | 4.0 ms / 4.4 ms | Same fix (it calls candidate links) |
| `GET /system/integrated-analysis` (PostgreSQL) | 642 ms / 632 ms | 18.9 ms / 9.7 ms | Same fix |
| PDF text extraction, 100 pages | 431 ms / 432 ms | 354 ms / 3.8 ms | pdf.js runs in a worker-thread pool with a 30 s timeout |
| Semantic analysis, first call | 83 ms (2 model round trips) | 43 ms (1 round trip) | Text and concepts embedded concurrently |
| Compare findings (72×72) | 5.7 ms | 4.7 ms | Fingerprints of the second document computed once |
| Document insights, 100 pages | 46 ms / 48 ms | 43 ms / 48 ms | Stop at 75 findings; cheap length check. Still close to 50 ms (see below) |

All outputs are unchanged:
- A dump of candidate pairs (1×, 3×, 10×) and of the comparison taken before the change is
  byte-identical after it.
- `test/analytics/candidate-links-equivalence.test.ts` checks the optimised pairing against
  the per-pair algorithm. It includes explicit IDs, cross references and results under the cap.
- The Python parity fixtures still pass.

Every other 10× scenario was already far below the gate. Indicators + IRSA take 6 ms, the
other engines under 30 ms, the strategic DOCX 29 ms, and the remaining HTTP routes 8-32 ms on
PostgreSQL.

## What is close to the limits

- **Document insights** take about 45 ms on a dense 100-page document, the lab's maximum.
  Profiling shows the cost is the per-segment term matching that parity requires. If real
  documents cross 50 ms, the next step is to run insights in the PDF worker with the extraction.
- **100× stress** (48,400 records) keeps p95 under 500 ms everywhere, but some engines block
  the loop: integrated analysis 244 ms, consensus 201 ms, indicators 63 ms. A batch of 2,500
  classifications takes 222 ms, though the API classifies one record per request. If a tenant
  reaches that size, the first step is again worker threads, which the ADR prefers, not a
  native adapter.
- **Semantic analysis** is latency-bound by the model. The orchestration adds about 2 ms.

## Re-running

The historical results above are not a current baseline. A later synthetic run aborted after
login with HTTP 403 (`mfa_required: true`): the freshly bootstrapped admin had not enrolled
MFA. The shared HTTP fixture now completes enrollment without disabling the guard. Its
functional regression is distinct from the current full-run measurements linked above. The
current HTTP timings include embedded SQL, not isolated SQL timings or query counts.
`--quick` still limits engine scales to 1×/10× and reduces repetitions; HTTP still uses 10×.
`--out <file>` still writes the complete result JSON only after all scenarios succeed.

### Focused HTTP fixture regression

From the repository root, use the app-local runner and its existing configuration:

```bash
cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 ./node_modules/.bin/vitest run test/analytics/benchmark-session.test.ts test/analytics/dashboard-app.test.ts --no-fs-module-cache
```

Vitest 5 persists transformed modules across invocations. After switching between the root
and app-local launchers in this pnpm checkout, the cached benchmark test retained an absolute
import of the root Vitest peer variant; the app-local runner then failed during collection
with `Vitest failed to find the current suite`. The same unchanged sources passed both files
with `--no-fs-module-cache` (4 tests). This option bypasses persisted transforms, not the test
configuration, assertions or isolation; it does not delete caches. Do not treat a root-launcher
pass alone as proof of compatibility with the app-local runner.

Run the full harness before and after any change to a hotspot, and save the JSON next to these
results. A new native adapter needs a run that trips the gate at 10× after algorithmic and
worker-thread fixes have been tried.

## Producción (Worker + Hyperdrive + Neon)

The local benchmarks above cannot show the production cost: every database message pays the
Lima ↔ us-east-1 round trip through the Worker and Hyperdrive. `bench/prod-screens-stress.ts`
measures it from the outside, as a signed-in user sees it.

### Method

- A synthetic load account with the `consulta` role (read-only; the tool refuses any other role)
  signs in with password and TOTP, selects one project and opens screens like the browser does:
  every GET a screen fires, in parallel, then the next screen. Each virtual screen loops over
  Inicio (7 requests), Registros (2) and IRSA (2) — see `SCREENS` in `bench/prod-screens.ts`.
- Steps of 1, 4 and 8 concurrent screens, 20 s each. Whole-screen latency runs from the first
  request to the last answer and counts only screens whose requests all answered 200.
- The run stops as soon as more than 20 % of requests fail (after 20 requests), and skips the
  remaining steps. It logs out at the end. Bodies are drained and discarded; output holds
  statuses and latencies only.

```bash
cd apps/api
SIPGES_LOAD_BASE_URL=https://<deployment> SIPGES_LOAD_SCOPE=<tenant/project> \
  pnpm run bench:prod-screens -- --env-file ~/.config/sipges-carga.env --label <name> --out <file>.json
```

The env file (or the environment) supplies `SIPGES_LOAD_USER`, `SIPGES_LOAD_PASSWORD` and
`SIPGES_LOAD_TOTP` (base32). Keep it outside the repository with mode 600; values are read
verbatim after the first `=`. Run it only against a deployment whose owner authorized the load.

### History (8 concurrent screens, 20 s, 0 errors in every step)

| Run (2026-11-03 UTC) | Requests in 20 s | Inicio p50 / p95 (ms) | Registros p50 / p95 (ms) |
| --- | ---: | ---: | ---: |
| v1.1.0 baseline | 286 | 2415 / 3133 | 2264 / 2961 |
| After #197 (fewer round trips per request) | 383 | 1764 / 2100 | 1415 / 1835 |
| After #199 (typed parameters, no type catalogue) | 504 | 1371 / 1830 | 932 / 1295 |
| #199 again (run labelled "after #200"; #200 was not deployed) | 497 | 1410 / 1991 | 927 / 1485 |
| #199 again, this tool | 488 | 1396 / 1629 | 963 / 1634 |

From v1.1.0 to #199 the same load serves about 1.7× the requests, and Inicio p50 drops by ~1 s.
CI failed on `main` after #200 and #201, so Deploy Workers skipped them: production stayed at
`cd001ea` (#199) and the last three rows measure the same code. Their spread (488–504 requests,
Inicio p95 1629–1991 ms) is the run-to-run noise. #200 and #201 have no production measurement yet.
The first four rows came from the ad-hoc script this tool replaces; it used the same screens,
steps and account, with a `floor(p·n)` percentile index instead of nearest rank (a difference of
at most one sample).

### Limits

- One synthetic account and one project: per-user caches (the #200 grant cache, sessions) are
  always warm or always shared, and real users spread over more tenants.
- 20 s steps give a few dozen screens per step: p95 moves by hundreds of ms between runs.
  Compare p50 and request counts first; treat p95 differences under ~300 ms as noise.
- The 1-screen step includes the cold start of the first isolate after a deploy (Inicio p95
  ~3 s in several runs); it is not a steady-state number.
- A run measures whatever is deployed, not what is merged: check the last Deploy Workers run
  (`gh run list --workflow "Deploy Workers" --branch main`) before labelling it.
- The client runs from one machine and network; its own latency to Cloudflare is included.
