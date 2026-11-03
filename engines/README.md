# engines — Rust computation engines (ADR 0032)

Pure computation engines in Rust, compiled to WebAssembly (`wasm32-wasip1`) and run inside the
Go backend with [wazero](https://github.com/tetratelabs/wazero) (pure Go, no cgo). Engines, each a byte-for-byte port of its TypeScript source:
indicators v0.4 + IRSA (`apps/api/src/contexts/indicators/domain`) and the analytics engines
situational, strategic, consensus, candidate links and integrated
(`apps/api/src/contexts/analytics/domain`).

| Path | What it is |
| --- | --- |
| `crates/indicators` | `sipges-indicators`: the engine (no I/O, `unsafe` forbidden). |
| `crates/indicators-wasm` | `sipges-indicators-wasm`: the WebAssembly ABI shim of the indicators engine (with `analytics-wasm`, the only `unsafe`). |
| `crates/analytics-common` | Python value semantics, record shapes and constants shared by the analytics engines. |
| `crates/{situational,strategic,consensus,candidate-links,integrated}` | One analytics engine each; `integrated` calls `consensus` and `candidate-links`. |
| `crates/analytics-wasm` | `sipges-analytics-wasm`: one WebAssembly module for the five analytics engines, selected by `op`. |
| `fixtures/generate.ts` | Runs the TypeScript engine on synthetic inputs and writes `fixtures/indicators.json` and `crates/indicators/src/defaults.json`. |
| `fixtures/<engine>.ts` | Same for each analytics engine: writes `fixtures/<engine>.json` (`--check` fails when stale). |
| `go/wasmengine` | Go host: loads the `.wasm`, pools instances, calls the ABI. |

Toolchain: Rust 1.98.0 pinned in `rust-toolchain.toml` (edition 2024); Go ≥ 1.25 (wazero v1.12.0).

## Commands

Run from `engines/` unless noted.

| Command | What it does |
| --- | --- |
| `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` | Format and lint (pedantic, no `unwrap`/`expect`/`panic`). |
| `cargo test` | Unit tests and the parity suite against `fixtures/indicators.json`. |
| `cargo build --release --target wasm32-wasip1 -p sipges-indicators-wasm -p sipges-analytics-wasm` | Builds `target/wasm32-wasip1/release/sipges_{indicators,analytics}_wasm.wasm`. |
| `cd go && go test -race ./...` | Runs the same fixtures through both `.wasm` modules from Go (`SIPGES_ENGINE_WASM` and `SIPGES_ANALYTICS_WASM` override the paths). |
| `cd go && go test -run '^$' -bench . ./wasmengine` | Benchmarks through WebAssembly. |
| `node engines/fixtures/generate.ts` (repo root, after `pnpm install`) | Regenerates fixtures and defaults from the TypeScript engine; `--check` fails when they are stale. |

## ABI

One JSON request in, one JSON response out. The module exports its `memory` and three functions;
offsets and lengths are 32-bit (`i32`).

| Export | Signature | Meaning |
| --- | --- | --- |
| `alloc` | `(len: i32) -> i32` | Reserves `len` bytes for the request; `0` when allocation fails. |
| `compute` | `(ptr: i32, len: i32) -> i64` | Runs the UTF-8 request at `ptr..ptr+len`; returns `(out_ptr << 32) \| out_len`. |
| `dealloc` | `(ptr: i32, len: i32)` | Frees a request buffer or a response. |

A call: `alloc(n)` → write the request → `compute(ptr, n)` → `dealloc(ptr, n)` → read
`out_len` bytes at `out_ptr` → `dealloc(out_ptr, out_len)`. The host owns both buffers' lifetimes.
An instance is single-threaded: run one call at a time per instance (`go/wasmengine` pools them).
A trap (for example memory exhausted) leaves the instance unusable; discard it.

### Requests

| `op` | Fields | Result (`value`) |
| --- | --- | --- |
| `indicators` | `records` (module → array of records), `meta`? | `computeIndicators` report. |
| `irsa` | `config`?, and `report` or `records` (+ `meta`?) | `computeIrsa` result. |
| `irsa_config_patch` | `config`?, `patch` | `{"ok":true,"value":config}` or `{"ok":false,"error":"weights_sum"}`. |
| `select_band` | `irsa` (number), `thresholds` | Band name. |
| `defaults` | — | `{"indicator_config", "irsa_config"}`. |

`config` defaults to `DEFAULT_IRSA_CONFIG` and `meta` to `INDICATOR_CONFIG` when absent or `null`.

The analytics module takes `records` as stored, `{module: [{id, payload}]}` (absent, `null` or a
`null` module means none), and returns the TypeScript function's result as `value`:

| `op` | Fields | TypeScript function |
| --- | --- | --- |
| `situational` | `records`, `project_id`, `generated_at`, `tenant_label`? (string or `null`) | `buildSituational` |
| `strategic` | `records`, `project_id`, `generated_at` | `strategicAssessment(extendedRecords(records), …)` |
| `consensus` | `records`, `project_id`, `generated_at` | `automatedConsensus(extendedRecords(records), …)` |
| `candidate_links` | `records` | `candidatePairs(extendedRecords(records))` |
| `integrated` | `records`, `project_id`, `generated_at` | `integratedAnalysis(extendedRecords(records), …)` |

A malformed `records` (not an object, a module that is neither an array nor `null`, an item
without a string `id` and an object `payload`) or a non-string `project_id`/`generated_at` is
`invalid_input`. `candidate_links` applies `normalize('NFKD')` with `unicode-normalization`
0.1.25 (Unicode 17.0); a character whose decomposition changed between Unicode versions could
differ from an older Node ICU, and no fixture uses one.

### Responses

`{"ok":true,"value":...}` or `{"ok":false,"error":{"code":...,"message":...}}`, with codes
`invalid_request` (not JSON, not an object, unknown `op`), `invalid_input` (a shape the TypeScript
engine throws on or does not type) and `unsupported_value` (rounding a value ≥ 1e21, where the
TypeScript helper throws). The engine never panics on input.

The response bytes equal `JSON.stringify` of the TypeScript result: same key order (array-index
keys first, then insertion order), same number spelling (`String(number)`), same escaping.

## Go host

`wasmengine.New(ctx, wasm, Options{})` compiles the module once; `Invoke` returns the raw response
bytes and `Call` decodes them into the `value` or a typed `*wasmengine.Error`. Options:
`MaxInstances` (pool size, default 4), `MemoryLimitPages` (default 2048 = 128 MiB per instance),
`RetainMemoryPages` (default 256 = 16 MiB: an instance whose memory grew past it is discarded
instead of pooled, because linear memory never shrinks) and `Interruptible`. `Stats()` reports
live and idle instances. Interruption is off by default because wazero's `WithCloseOnContextDone` made the
engine 5.3x slower (2.28 → 12.09 ms per 1x request); without it the context is checked before
each call and a call runs to completion. A trapped or interrupted instance is discarded.
`Close` returns only after the calls in flight have ended (closing the runtime under running guest
code raced with the WASI host functions): an uninterruptible call runs to completion, an
interruptible one is stopped, and both it and callers still waiting for an instance get `ErrClosed`.

## Performance

Measured on 2026-11-03 (AMD Ryzen 5 4600H, a shared machine under load, so treat as ±30 %).
Each figure covers parsing the request, computing and writing the response.

| Request | TypeScript (Node 26) | Rust native | Rust via wazero |
| --- | --- | --- | --- |
| `indicators`, 1x synthetic (all modules, 200 KiB) | 1.5–3.6 ms | 0.8–1.2 ms | 2.9 ms |
| `irsa`, 3x synthetic (320 KiB) | 3.2–6.1 ms | 2.2–3.2 ms | 7.0 ms (2.1 ms/call with 4 instances) |

Native Rust is 1–2x faster than V8 here. Through WebAssembly a single call is slower than V8
(wazero's code is about 3x slower than native); the gain is that Go runs it in-process and in
parallel, without a Node.js process. Stress (`go test -run Stress`, `SIPGES_STRESS_CALLS=20000`): 20,000
mixed fixture calls from 32 goroutines over 4 instances, 0 mismatches, ~3,900 calls/s, latency
(including the wait for a free instance) p50 7.7 ms, p95 15 ms, p99 20 ms. A leaked buffer would
exhaust a 4 MiB memory within ~500 calls; 2,000 calls pass.

## Parity rules worth knowing

Ported exactly, each pinned by a fixture:

- `pyRound`: correctly rounded on the exact binary value, ties to even (`2.675 → 2.67`).
- `String(number)`: shortest round-trip digits; on an exact tie between two shortest candidates
  ECMAScript picks the even digit (`1128632177133113.25` → `…113.2`), unlike Rust's formatter.
- `pyFloat` uses `toFixed(1)`, which prints the exact integer (`123456789012345683968.0`).
- `trim` removes ECMAScript whitespace (includes U+FEFF, excludes U+0085).
- Objects keep source key order; duplicate keys keep the first position and the last value;
  array-index keys (`"0"`…`"4294967294"`) enumerate first, which also decides IRSA band order.
- Floats are parsed correctly rounded (`serde_json` `float_roundtrip`), like `JSON.parse`.

Deliberate differences (outside the TypeScript types, documented instead of mimicked):
non-numeric weights, scores or threshold bounds are `invalid_input` instead of JavaScript
coercion; lone UTF-16 surrogates (`"\ud800"`) and numbers beyond `f64` (`1e400`) are rejected by
the JSON parser instead of becoming `U+FFFD`-free strings or `Infinity`.

## Fixtures

The analytics fixtures (`fixtures/{situational,strategic,consensus,candidate-links,integrated}.json`)
hold `{name, request, value}` per case: the request text and `JSON.stringify` of the TypeScript
result. Inputs are synthetic (`syntheticRecords`, the domain tests' inputs, edge cases such as
`null` and object values, U+FEFF, `İ`/`Σ`, compatibility characters); 138 cases in all.

`fixtures/indicators.json` holds raw request/response text per case (one per line), the Python
reference values of `apps/api/test/indicators/python-parity.fixture.json`, and scalar checks for
`pyRound`, `String(number)` and `pyFloat`. Inputs are synthetic: the domain tests' inputs, the
benchmark generator (`apps/api/bench/synthetic.ts`) and hand-written edge cases. CI regenerates them
and fails on any difference, so a change to the TypeScript engine cannot drift silently.
