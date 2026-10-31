# Dashboard candidate: bounded public-HTTP differential

**PASS — 16 comparison checks**, base `4a4b5f0` versus the unchanged working-tree candidate.
This is writer self-verification for production-candidate T4 (S1–S4), not independent
security review, a full gate, or production certification.

## Results

| Observation | Base | Candidate |
| --- | ---: | ---: |
| Public GET endpoints, identical status/content-type/bytes/SHA256 | 7 | 7 |
| Anonymous dashboard | 401 | 401 |
| Ungranted dashboard project query | 403 | 403 |
| Dashboard response bytes | 191 | 191 |
| Untimed dashboard materialized rows | 3,580 | 3,580 |
| Untimed dashboard materialized row-array JSON bytes | 1,792,483 | 277,200 |
| Dashboard HTTP p50, milliseconds | 49.61 | 31.66 |
| Dashboard HTTP p95, milliseconds | 59.86 | 51.09 |

Materialized JSON fell by **1,515,283 bytes (84.54%)**, with no target percentage
assumed. This counts the SQL result array including `module`, `id` and `payload`,
not the downstream domain record arrays from the earlier reader experiment; those
measurements have different denominators and must not be conflated.

`base-http.json` and `current-http.json` retain response digests, byte lengths,
exact content types, complete safe dashboard/guard JSON, raw latency samples and
check counters. `comparison.json` records all 16 named checks and limitations.
All seven endpoint responses were 200/application/json; SHA256 covers the actual
`arrayBuffer()` bytes without normalization, including generated metadata.

Anonymous body: `{"detail":"Inicie sesión para acceder a MASCLI"}`.
Ungranted query body: `{"detail":"Proyecto fuera de alcance"}`.
The complete public dashboard and `/api/eventos?limit=-1` responses remained
unchanged after rejection, checked through HTTP, not through stored records.

## Method and exact commands

Working directory: repository root. Node v26.7.0, installed dependencies unchanged.
Only the archive paths below were extracted; its API node_modules symlink was used
read-only (no install, dependency mutation or permission changes).

```sh
mkdir -p odd/evidence/production-candidate/.scratch/http-proof-20261013/base
git archive 4a4b5f0 apps/api/src apps/api/bench apps/api/package.json package.json | tar -x -C odd/evidence/production-candidate/.scratch/http-proof-20261013/base
ln -s "$PWD/apps/api/node_modules" odd/evidence/production-candidate/.scratch/http-proof-20261013/base/apps/api/node_modules
```

A shared transient `experiment.mjs` imports each root's `buildContainer`, `createApp`,
`loadConfig`, migrator, PGlite adapter, synthetic generator and benchmark path list.
Each invocation creates and closes a new in-memory PGlite, applies all migrations,
and generates `syntheticRecords(10, 42)` (4,840 records). Seed insertion follows the
benchmark's batch/id convention, with both record timestamps fixed to the injected
clock `2026-10-13T12:00:00Z`.

The full composition retains requireMfa=true, real password/session handling,
public TOTP setup/enable using `totp.codeAt(secret, fixedClock)`, and public project
selection (303). No principal is injected. Synthetic session/TOTP values remain
in memory and are never printed. The embedding adapter throws if invoked; none
was invoked. No real data, database URL or external provider is used.

All seven BENCHMARK_HTTP_PATHS are requested once for differential snapshots,
then anonymous/ungranted guards and unchanged-state checks run. A separate untimed
dashboard request enables a transparent query/exec/transaction SqlClient wrapper:
it counts only the returned rows of `FROM public.module_records`, preserving the
original adapter and transaction client, with no duplicated transaction-result
counting. Both versions make exactly one counted query. Timings run afterwards
with instrumentation inactive: three warmups and ten sequential dashboard GETs,
each status 200 and fully consumed with `arrayBuffer()`; p50/p95 use nearest rank.

Successful commands were run serially, each with its own foreground 30s limit:

```sh
timeout 30s node odd/evidence/production-candidate/.scratch/http-proof-20261013/experiment.mjs odd/evidence/production-candidate/.scratch/http-proof-20261013/base odd/evidence/production-candidate/base-http.json > odd/evidence/production-candidate/base-http.attempt3.stdout.log 2> odd/evidence/production-candidate/base-http.attempt3.stderr.log; code=$?; printf '%s\n' "$code" > odd/evidence/production-candidate/base-http.attempt3.exit; printf 'base attempt3 exit=%s\n' "$code"
timeout 30s node odd/evidence/production-candidate/.scratch/http-proof-20261013/experiment.mjs . odd/evidence/production-candidate/current-http.json > odd/evidence/production-candidate/current-http.stdout.log 2> odd/evidence/production-candidate/current-http.stderr.log; code=$?; printf '%s\n' "$code" > odd/evidence/production-candidate/current-http.exit; printf 'current exit=%s\n' "$code"
timeout 30s node odd/evidence/production-candidate/.scratch/http-proof-20261013/compare.mjs > odd/evidence/production-candidate/comparison.stdout.log 2> odd/evidence/production-candidate/comparison.stderr.log; code=$?; printf '%s\n' "$code" > odd/evidence/production-candidate/comparison.exit; printf 'comparison exit=%s\n' "$code"
```

Each program exited **0**, without timeout or background work remaining. Per-version
checks: five bootstrap groups, twelve public snapshots, two exact guard bodies,
two public unchanged-state checks, thirteen successful warmup/sample requests,
one materialization group. Comparison: sixteen groups, including seven complete
HTTP tuples, two guard tuples, two unchanged-state flags and five workload/materialization
checks. These are grouped checks, not a claim about a test-suite assertion count.

## Retained failures and limits

Two initial base invocations exited 1; the exact program/root/output arguments were
the same as the successful base run, with log/exit stems `base-http` and
`base-http.attempt2` respectively. First, the harness guessed the wrong anonymous
message (`No autenticado`); readback of the public middleware confirmed the observed
message above. Second, the instrumentation regex omitted the `public.` schema and
counted zero rows. Only the transient harness was corrected, once per failing check.
No response difference was normalized away and candidate code was never changed.
All failure stdout/stderr/exit files are retained, not overwritten.

Successful stderr contains Node's existing localStorage experimental warning.
Stdout contains application request logs plus the compact completion record;
stderr is separately captured, and `.exit` records the program status before the
shell prints its summary. Request IDs, trace/span IDs, wall-clock log timestamps,
PIDs and durations naturally differ; CLI stream byte equality is neither expected
nor claimed. The injected clock fixes application response metadata, not the logger.

This is in-process public HTTP (`app.request`), not TCP transport. Ten serial samples,
base first, are diagnostics, not throughput/load/capacity evidence. PGlite is not
real PostgreSQL-server verification. Full API/static gates and independent security
review are separate from this experiment; their completed local outcomes are recorded below.
Operational acceptance remains unmet.

Only this evidence directory was written by the experiment worker. JSON and this README
are narrow versionable outputs; raw logs remain untracked. The archive and transient
programs were not committed. The worker retained its owned scratch because its tool safety
prohibits deletion; after consuming the evidence, the parent validated the canonical path
and removed only `.scratch/http-proof-20261013/`. The node_modules symlink was unlinked,
not followed; installed dependencies and all evidence/failure logs remain intact.

Parent-recorded SHA256 before removing the transient programs:

- `experiment.mjs`: `07e45256111729dda12f3ae60ea95df2f6dbe3218e4681af37145b273236e821`
- `compare.mjs`: `27d9892ff5397a3aa758235a8964f0e860f37234e98cc6d391882ae63a779cde`

The command blocks above document the executions that occurred; they are not a turnkey
script distribution after transient-program cleanup. The `comparison.json` limitation
about scratch retention records the worker handoff state, superseded by this parent cleanup.
The parent separately checked all three successful `.exit` files and the 16-group PASS JSON.
Broader gates are recorded separately in `broad-gates.*`; no pending run is presumed green.

## Parent gate, independent review and remaining decisions

Source commit `2ba2b5a7e729fe32fea0a5139baf799466dd65dc` (from `4a4b5f0`) was not changed
by these documentation updates.

**Parent gate (`broad-gates.*`).** One serialized job, run after the experiments from a
clean environment, exited **0**: `pnpm lint; node scripts/check-boundaries.mjs; pnpm typecheck;
cd apps/api; ./node_modules/.bin/vitest run --no-fs-module-cache`. Read from the retained logs:

| Check | Observed |
| --- | --- |
| Lint / format | `.exit` 0; "All matched files use Prettier code style!" |
| Architecture boundaries | 737 modules, 2,177 dependencies |
| Typecheck | 6 of 7 workspace projects, all Done |
| API tests | 99 files passed, 5 skipped; 696 tests passed, 14 skipped; vitest duration 514.37 s (whole job about 9 min 11 s) |

Stderr keeps Node's `localStorage` experimental warnings and the PDF "Indexing all PDF
objects" warnings. Not claimed: aggregate `pnpm verify`, a new browser run, a real
PostgreSQL-server run, current remote CI or any public-deployment proof.

**Independent review.** Verifier `mvo6yuz6-6-pjzz` was static-only and found no blocker. It
did not run tests independently and is not a native approval. Native assessment of the
committed range stays unassessable (undeclared untracked files; no candidate, reviewDue
result or authority); no review tool was invoked here.

**Measurement scope.** The dashboard latency samples (three warm-ups and ten GETs per
version, base first, in-process HTTP) are diagnostic only. The 84.54% reduction counts SQL row
arrays; the earlier 89.93% counts domain records, so the denominators differ. The 16
worker HTTP checks PASS, including seven byte-exact GET responses (the dashboard body is
191 bytes) and 401/403 without mutation.
Two harness failures remain retained with no production-source change. `comparison.json`
is immutable: its scratch-retention note records the worker handoff and is superseded by
the parent cleanup above.

**Remaining decisions (operator prerequisites, not new authorizations).**

| Decision | Exact owner input |
| --- | --- |
| PostgreSQL server proof | An explicitly synthetic, least-privilege connection |
| Restore drill | A coordinated database/object restore environment and its keys |
| Identity, storage, monitoring | Institutional owners and their environment evidence |
| External acceptance | The existing data-quality, Situaciones, media and territorial owners |

No production readiness is claimed and no owner gate is closed; every inherited owner ODD
stays open as appropriate.
