# import-base-maestra (Rust)

Rust port of `apps/api/src/tools/base-maestra` (ODD go-rust-stack T43, ADR 0032). It loads the
prototype's Base Maestra into one tenant, **insert-only**: records already present are never
replaced, so it can be re-run and never overwrites edits. Runbook and production rule:
[docs/migration/base-maestra.md](../../../docs/migration/base-maestra.md) (real data only with the
owner's word; dry run first).

```sh
cd engines && cargo build --release -p sipges-base-maestra
SIPGES_DATABASE_URL=… SIPGES_DATA_KEY=… target/release/import-base-maestra --seed <file> [--scope C/P] [--apply]
```

The TypeScript tool stays until the owner retires it.

## Same as TypeScript

- Flags (`--seed`, `--scope` defaulting to `SIPGES/PRJ-SECHURA`, `--apply`, `--help`, `--`
  ignored), usage text and exit codes (0, 1, 2), the JSON report, the «Simulación» line, «El
  proyecto … no existe» and `Importación de Base Maestra fallida: <Error|SyntaxError|TypeError|PostgresError>`.
- `JSON.parse` semantics with an own parser (`src/json.rs`): every number an `f64` (`1e400` is
  `Infinity` and stored as `null`, `12345678901234567890` as `12345678901234567000`), a repeated
  key keeps its first position with the last value, array-index keys enumerate first (which
  orders the problems), invalid UTF-8 in the file becomes U+FFFD, a BOM is a syntax error.
- Ids: the module id field when present (`String(number)` spelling), otherwise
  `<prefix>-<8 hex of sha256(module + canonical JSON)>`, with keys sorted by UTF-16 units as
  `Array.prototype.sort` does; same problems (codes and positions only) in the same order.
- Pending migrations applied first (embedded SQL) and PostgreSQL notices printed as postgres.js
  does; one `existing` lookup per module, then one transaction per module (chunks of 500 rows,
  insert-only, one `IMPORT` audit row with the created count). An interrupted run keeps the
  modules already committed; a re-run inserts only what is missing.

## Known differences

| Case | TypeScript | Rust |
| --- | --- | --- |
| A lone UTF-16 surrogate escape (`"\ud800"`) in the file | parsed; the dry run counts it, `--apply` fails in PostgreSQL | `SyntaxError` before connecting, nothing written |
| JSON nested deeper than 100,000 levels | parsed if Node's stack allows | `SyntaxError` |
| `SIPGES_DATABASE_URL` unset | embedded PGlite | refuses, exit 1 |
| Other API settings invalid | `loadConfig` fails, exit 1 | ignored |
| TLS to a non-local host; unknown URL parameters; driver error names | as in [review-materialize](../review-materialize/README.md) | as there |

## Differential test

`engines/tools-parity/base-maestra.ts` writes synthetic seed files (never `data/seed.json`) and
runs 26 steps: flags, missing, invalid, BOM and non-UTF-8 files, a non-object file, unknown,
array-index and non-importable modules, ids `0`, `-0`, `7.0`, `''`, `true`, objects and over 200
units, NUL in keys and values, duplicates, `1e400`, big integers, repeated keys, `__proto__`,
emoji and U+FFEF keys, 1,203 rows in one module, a pre-existing record that must survive, and a
trigger that interrupts the run mid-module before resuming.
