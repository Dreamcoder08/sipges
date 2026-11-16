# 0034 — Rust placement criterion: measured need, not a fixed list

## Status

Accepted (2026-11-15). Amends [0032](0032-go-backend-rust-engines.md) §3: the closed list of Rust
engines and tools becomes a criterion. Everything else in 0032 stands.

## Context

The owner restated the stack: «frontend full typescript , backend full go casi para todo y rust para
operaciones criticas o donde el problema importe», and asked for «maxima eficiencia , performance ,
calidad y buenas practicas senior en el backend», questioned against current sources.

ADR 0032 §3 names which code is Rust (the pure engines and four operator tools). The owner's wording
is a criterion instead, so new code needs a rule that says when it applies.

Facts that shape the rule, all read on 2026-11-15:

- **Rust inside Go is not faster than TypeScript here.** One indicators request takes 1.5–3.6 ms in
  TypeScript, 0.8–1.2 ms in native Rust and 2.9 ms through wazero
  ([go-rust-stack](../../odd/tasks/go-rust-stack.md), L8). The WebAssembly boundary and the JSON ABI
  cost about as much as the port gained.
- **That is a property of the runtime, not of our code.** On the libsodium suite wazero ran at
  4.84×, 4.70× and 4.72× native in 2024, 2025 and 2026 (v1.12.0), while Wasmer 7.1.0 reached 1.33×
  and Wasmtime 46.0.0 1.46×
  ([Performance of WebAssembly runtimes in 2026](https://00f.net/2026/06/23/webassembly-runtimes-2026/)).
  wazero v1.12.0 is the latest release and lists no compiler speed-ups
  ([releases](https://github.com/wazero/wazero/releases)). The faster runtimes need cgo.
- **Request latency is round trips, not CPU.** A production request waited 39 s with 10 ms of CPU
  (0032, Context); a query costs 26–33 ms from the container (0032 §4).
- **Go's own runtime improved without code changes.** Go 1.26 made the Green Tea collector the
  default, expecting «a 10–40% reduction in garbage collection overhead in real-world programs», and
  cut the baseline cgo call overhead by ~30% ([Go 1.26](https://go.dev/doc/go1.26)). Go 1.27, which
  `apps/api-go` already uses, backs `encoding/json` with the v2 implementation («unmarshal
  performance is significantly faster»), lowers the cost of small allocations by up to 30% and makes
  the `goroutineleak` profile generally available ([Go 1.27](https://go.dev/doc/go1.27)).
- What Rust did deliver: output byte-identical to the TypeScript engines on 179 parity cases (indicators and the five
  analytics engines), no
  `unsafe` outside the two ABI shims, and reproducible `.wasm` builds checked in CI (go-rust-stack,
  L8, L10, L24).

## Decision

1. **Go is the default** for every backend concern: HTTP, identity, tenancy, agents, queues, workers
   and any code that waits on the database, the network or a file.
2. **Rust is chosen for a unit only when one of these holds, and the reason is written down** in the
   unit's feature document:
   1. _Exactness_: the result must be reproducible bit for bit across runtimes or releases (scores,
      indicators, anything a decision or an audit depends on).
   2. _Untrusted input_: it parses or transforms bytes from outside the system, where a memory fault
      would be a security defect.
   3. _Measured CPU cost_: a profile of the Go implementation shows the unit, not I/O, dominating a
      request or a job, and a Rust prototype measured the same way is faster after the boundary cost.
3. **Speed is never assumed.** A unit proposed under 2.3 without both measurements stays in Go. A
   unit chosen under 2.1 or 2.2 states that its reason is correctness, not speed.
4. **The boundary stays as it is**: pure functions, no I/O, `wasm32-wasip1`, run with wazero through
   `engines/go/wasmengine`, one JSON request and one JSON response. Operator tools stay native Rust
   binaries.
5. **Native Rust inside the Go process (cgo) or a faster WebAssembly runtime is not adopted.** It is
   reconsidered in a new ADR only when a unit under 2.3 is measured too slow through wazero and
   batching calls did not fix it.
6. What 0032 §3 already ported stays in Rust: the engines qualify under 2.1, PDF text
   ([0033](0033-pdf-text-in-wasm.md)) under 2.2, and the operator tools stay as 0032 decided.

## Consequences

- Performance work on the backend starts in Go: fewer round trips, a warm pool, batched queries,
  then `pprof`. Rust is the last step, not the first.
- A Rust proposal now costs a profile and a prototype, which is slower to start and avoids a port
  that gains nothing.
- The engines' value is stated honestly as determinism and safety; nobody should expect a request
  to get faster because its engine is Rust.
- Engine calls should be batched per request where the route allows it, since each crossing pays
  the JSON encoding twice.
- Follow-ups, not decided here: run the `goroutineleak` profile in the Go test suite, and keep the
  parity run as the guard for the `encoding/json` v2 change.

## Alternatives considered

- **Keep the closed list of 0032 §3.** Clear, but silent about new code, so each new engine would
  need its own ruling.
- **Rust for anything "critical", by judgement.** It reads like the owner's words, but without a
  test every context qualifies; identity and tenancy are critical and are I/O-bound Go code.
- **Native Rust through cgo, or Wasmtime/Wasmer.** Roughly 3× faster on computation than wazero, at
  the price of a C toolchain in the image, cross-compilation per platform, and losing the pure-Go
  static binary and wazero's sandbox. No measured unit needs it.
- **Port the engines to Go.** One language fewer, but it discards the passing parity suites and the
  exact floating-point work for no measured gain.
