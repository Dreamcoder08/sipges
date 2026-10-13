# 0005 — Processing ports and Go/Rust adapter policy

## Context
User requirement S4: Go or Rust "where it should be" for performance and scalability, decided as "only with a benchmark that justifies it". Hotspots (behavior contract §7): indicator computation, candidate-link pairing, document insights/compare, PDF extraction, semantic analysis (latency-bound).

## Decision
- Every heavy operation sits behind an application **port**: `DocumentTextExtractor`, `DocumentReportRenderer`, `IndicatorEngine`, `LinkCandidateFinder`, `EmbeddingProvider`.
- First adapters are TypeScript: `unpdf` (pdf.js) for PDF text, `mammoth` for DOCX text, `docx` for DOCX generation, pure TS engines.
- Algorithmic fixes come first: precompute token fingerprints once (Python recomputes inside an O(n²) loop), single pass over records for indicators, parallel embedding calls with a bounded pool.
- **Native adapter gate:** T12 benchmarks each port with synthetic data at 10× current volume. A Go (or Rust) adapter is built only if, after algorithmic fixes, p95 latency exceeds 500 ms or a CPU-bound task blocks the event loop > 50 ms that worker threads cannot solve. The adapter runs as a separate process behind the same port (HTTP/gRPC) and must pass the same contract tests as the TS adapter.
- Default candidate if the gate trips: **Go** (toolchain present, simpler deployment); Rust only for a measured case where Go's GC is the bottleneck.

## Consequences
- No second language unless the numbers demand it; when they do, swapping is an adapter change, not a rewrite.
- Benchmark results are recorded in `docs/benchmarks/` with method and hardware.

## References
Brendan Gregg "Systems Performance"; Node.js "Don't Block the Event Loop" guide.
