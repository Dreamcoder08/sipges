---
name: mascli-benchmark
description: "Trigger: benchmark, performance, p95, hotspot, Go or Rust adapter. Runs the ADR 0005 processing benchmarks before and after a change and compares them."
license: Apache-2.0
metadata:
  author: Dreamcoder08
  version: "1.0"
---

## Activation Contract

Use before and after changing a processing hotspot (analytics engines, document lab, PDF, semantic analysis) or when someone proposes a native adapter.

## Hard Rules

- Synthetic data only (`apps/api/bench/synthetic.ts`); never load `data/seed.json` or `data/*.db`.
- A Go/Rust adapter needs a 10× run that trips the gate (p95 > 500 ms or loop block > 50 ms) after algorithmic and worker-thread fixes (ADR 0005).
- Outputs must stay identical; add an equivalence test when optimising.
- Record method, hardware and both JSON files under `docs/benchmarks/`.

## Decision Gates

| Result at 10× | Action |
| --- | --- |
| All ok | Keep Node; document. |
| Trips, CPU-bound | Algorithm first, then worker threads, then re-measure. |
| Trips after both | Propose a native adapter behind the processing port; ask the user. |

## Execution Steps

1. `MASCLI_BENCH_DATABASE_URL=postgres://… pnpm --filter @mascli/api bench -- --out /tmp/before.json` (omit the URL for PGlite; `--quick` for 1×/10×).
2. Make the change; run again to `/tmp/after.json`.
3. `pnpm --filter @mascli/api bench:compare -- /tmp/before.json /tmp/after.json` (exit 1 if any 10× row trips).

## Output Contract

Markdown table from step 3, gate verdict, files saved.

## References

- `docs/benchmarks/README.md`, `docs/adr/0005-processing-ports-and-native-adapters.md`
