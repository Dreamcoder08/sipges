---
name: sipges-rust-engine
description: "Use when a pure SIPGES TypeScript engine (no I/O, under apps/api/src/contexts/*/domain) must be ported to Rust in engines/, exported through WebAssembly and run from Go with wazero, byte-identical to TypeScript."
---

# Port a TypeScript engine to Rust

One engine per branch (`feat/rust-<engine>` from `origin/main`). Read first: `engines/README.md`
(ABI, commands), the TypeScript engine and its tests, and its row in `odd/tasks/go-rust-stack.md`.

## Steps

1. **Crate.** `engines/crates/<engine>` (`sipges-<engine>`), added to the workspace `Cargo.toml`. No
   I/O, `unsafe` forbidden, no `unwrap`/`expect`/`panic` (clippy pedantic). Shared Python/JS value
   semantics live in `crates/analytics-common`; reuse it before writing new helpers.
2. **JavaScript semantics, not Rust defaults.** Numbers print as `String(number)` /
   `JSON.stringify` (shortest round-trip, `-0` as `0`); V8's `Math.exp`/`Math.log`/`Math.pow` can
   differ from Rust's in the last bit, so port the exact algorithm when a fixture shows it. Strings are
   UTF-16: lengths, `slice`, ordering and lone surrogates follow JavaScript (`serde_json` rejects unpaired
   surrogate escapes, so carry such text as UTF-16 units). `localeCompare` and
   `normalize('NFKD')` need generated tables pinned to the Unicode/ICU version Node uses.
3. **Fixtures from TypeScript.** `engines/fixtures/<engine>.ts` runs the TypeScript engine on synthetic
   inputs (edge cases: empty, `null` modules, ties, emoji, accents, huge and tiny floats) and writes
   `fixtures/<engine>.json`; `--check` fails when stale. `cargo test` compares byte for byte.
4. **WebAssembly export.** Add an `op` to `crates/analytics-wasm` (or a new `*-wasm` shim with the
   same `alloc`/`compute`/`dealloc` ABI); malformed input returns `invalid_input`, never traps.
   Document the request in the README tables.
5. **Go binding.** `engines/go/wasmengine` runs the same fixtures through the `.wasm` with wazero
   (`go test -race`). When `apps/api-go` serves it, embed the built module and call it through the
   pooled host; never re-implement the rule in Go.
6. **CI.** Add the TypeScript source and fixture inputs to the `paths` of `.github/workflows/rust.yml`
   so a TypeScript change re-runs the parity.
7. **Commits sized for review.** Generated files (Unicode or collation tables, large fixtures,
   `.wasm`) go in their own `chore(engines): add the generated …` commit, before the engine commit, so
   each reviewable unit fits the native review budget. Engine, wasm export and Go binding follow as
   separate work units (see `work-unit-commits`).

## Checks

Run from `engines/` with memory limits (`-j 2`, `go test -p 2`):

```sh
cargo fmt --check && cargo clippy -j 2 --all-targets -- -D warnings && cargo test -j 2
cargo build -j 2 --release --target wasm32-wasip1 -p sipges-analytics-wasm
cd go && go test -race -p 2 ./...
node engines/fixtures/<engine>.ts --check   # from the repository root
```

Then `sipges-verify` and `sipges-task-pr`.

## Report

Engine, fixture count and byte equality, Unicode/ICU versions pinned, new `op`, commits (generated vs.
authored), and the Log entry for the orchestrator in the PR description.

Reference: [Codex skills](https://developers.openai.com/codex/skills/).
