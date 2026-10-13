# Processing benchmarks (T12)

ADR 0005 allows a Go or Rust adapter only when a benchmark justifies it. The gate trips when,
after algorithmic fixes and at 10× the current data volume:
- p95 latency exceeds 500 ms, or
- a CPU-bound task blocks the event loop for more than 50 ms and worker threads cannot solve it.

**Result: the gate does not trip.** Four fixes brought every 10× scenario under both limits:
- two algorithmic fixes (candidate links and finding comparison);
- one PDF worker thread;
- one parallel embedding call.

No second language is added.

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
  4,840 records from **real PostgreSQL 16** (`MASCLI_BENCH_DATABASE_URL`). Without that
  variable the harness uses embedded PGlite, whose queries run on the event loop.
- Hardware: Intel Xeon @ 2.10 GHz, 4 cores, 16 GiB. Node 22.22.0.

```bash
corepack pnpm --filter @mascli/api bench                     # full run, embedded PGlite
MASCLI_BENCH_DATABASE_URL=postgres://… corepack pnpm --filter @mascli/api bench -- --out r.json
corepack pnpm --filter @mascli/api bench -- --quick          # 1× and 10× only, fewer runs
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

Run the full harness before and after any change to a hotspot, and save the JSON next to these
results. A new native adapter needs a run that trips the gate at 10× after algorithmic and
worker-thread fixes have been tried.
