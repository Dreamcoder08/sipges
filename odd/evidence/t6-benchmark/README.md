# T6 synthetic HTTP benchmark evidence

The full local benchmark completed with exit **0**, producing **36 measurements**, including
all seven HTTP scenarios. The fixture now enrolls the synthetic admin in MFA and selects its
authorized project through public endpoints, without disabling product guards.

**Completion is not a performance pass:** dashboard and IRSA exceeded the 50 ms loop-block
threshold at 10× on embedded PGlite. See [the full result JSON](full.json).

## Environment and scope

- Base: `b811d8b`; branch: `fix/t6-synthetic-http-benchmark`.
- Recorded at `2026-10-24T10:24:20.964Z`; Node `v26.7.0`, Linux x64.
- AMD Ryzen 5 4600H, 12 logical CPUs, approximately 7 GiB RAM.
- Synthetic records only; HTTP uses 10× / 4,840 generated records, 30 measured runs and
  three warm-ups per route. Engine scenarios also include 1× and 100×.
- In-process Hono `app.request` with embedded PGlite: includes authorization, SQL reads,
  computation, serialization and response consumption. No TCP/server/network measurement.
- MFA enrollment, project selection, migrations and synthetic inserts are outside timed GETs.
- PDF and cold synthetic semantics use 10 runs; semantics use the existing 40 ms model double.

## Full-run HTTP measurements

All values are milliseconds. SQL costs are included in endpoint latency, not isolated or
reported as query counts. `situational-analysis` is the older engine, **not Situaciones 4.0**.

| Route | p50 | p95 | Maximum | Loop block |
| --- | ---: | ---: | ---: | ---: |
| `/api/dashboard` | 51.47 | 86.43 | 88.96 | **86.10** |
| `/system/irsa` | 49.13 | 63.84 | 64.65 | **64.44** |
| `/system/situational-analysis` | 18.39 | 23.01 | 24.62 | 25.89 |
| `/system/integrated-analysis` | 28.95 | 36.34 | 40.56 | 43.96 |
| `/system/consensus-engine` | 20.52 | 26.00 | 28.99 | 31.75 |
| `/system/strategic-assessment` | 21.04 | 25.99 | 28.63 | 34.42 |
| `/api/eventos?limit=-1` | 8.99 | 12.69 | 12.97 | 12.71 |

All p95 values are below 500 ms. Four pure-engine 100× scenarios also exceed 50 ms loop
block: IRSA 90.35, integrated analysis 306.20, consensus 188.58 and batch classification
190.61. These numbers do not establish a regression against different historical hardware,
production capacity, or the ADR's prerequisites for adding a native adapter.

## Reproduction

From the repository root, with installed dependencies:

```bash
mkdir -p odd/evidence/t6-benchmark
(cd apps/api && env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 \
  node bench/run.ts --out ../../odd/evidence/t6-benchmark/full.json)
```

This intentionally supplies **no database URL or provider credentials**. Do not reuse a
real database connection to reproduce this result.

## Verification ledger

| Check | Observed outcome |
| --- | --- |
| Worker public-session RED | Login 200, dashboard 403 with `mfa_required: true`; 1 failing test, 5.62 s |
| Worker GREEN | Same shared-fixture regression: 1 passing test, 5.09 s; worker output combined stdout/stderr |
| Full harness | Exit 0, 43 s, 36 measurements; seven HTTP scenarios at 30 runs |
| `--quick --out` differential | Exit 0 comparison: base exits 1/dashboard 403/no JSON; fixed runner exits 0 with 29-row JSON, seven HTTP scenarios at five runs |
| Differential invariants | All 22 pre-HTTP scenario labels/order preserved; no 100× in quick mode; timing/IDs/timestamps are expected nondeterministic differences |
| Initial static checks | Lint, formatting, boundaries 735 modules/2,169 dependencies pass; typecheck fails TS2322 on unvalidated MFA JSON |
| Type correction | Explicit runtime narrowing replaces invalid annotation; formatting, lint and API typecheck pass |
| Root-launcher focused run | New regression passes, existing dashboard suite fails to load: Vitest context mismatch; exit 1 |
| App-local cached focused run | Existing dashboard tests 3/3 pass, new regression fails to load: persisted root-peer transform; exit 1 retained |
| App-local without persisted transforms | Worker: unchanged sources/configuration, `--no-fs-module-cache`, 2 files / 4 tests pass, exit 0, 13.48 s; [attributed handoff](worker-runner-handoff.md) |
| Independent review | Static code/spec review plus existing parent-owned logs: no severe candidate-caused finding; no fresh independent test execution |
| Native assessment | Unassessable because of undeclared untracked files; no reviewDue, lineage or native approval established |

The full benchmark and differential preceded the JSON type narrowing. Their successful
setup already returned the validated string shape, so timed GET behavior is unchanged.
The app-local regression passes with persisted transforms bypassed; plain cached invocation
remains a failure, not a green gate. The parent spot-checked the root-peer absolute import
in the cached artifact. No caches were deleted, and no T5 configuration was changed.

## Retained artifacts and limitations

`full.json`, this index and the attributed worker handoff are versioned evidence. Raw local evidence remains untracked:
`full.{log,stderr,exit}`, `base-quick.{log,stderr,exit}`, `current-quick.{json,log,stderr,exit}`,
`differential-check.{log,stderr,exit}`, `checks.{log,stderr,exit}`,
`checks-fixed.{log,stderr,exit}` and `checks-app-local.{log,stderr,exit}`.
The base scratch copy was removed after comparison; logs and exit codes remain.

Earlier T5 failures and its accumulated passing components remain in
[the T5 evidence index](../t5-verification/README.md); they were not rerun or relabeled.
No real PostgreSQL server, isolated SQL timings/counts, transport load/concurrency,
real model/provider, real data, or production performance was measured. The earlier
Situaciones 4.0 service/in-memory-reader measurements remain a separate limited baseline.
No push, PR or deployment was performed. The Node localStorage experimental warning
remains visible in stderr.
