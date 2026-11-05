# review-materialize (Rust)

Rust port of `apps/api/src/tools/review-materialize` (ODD go-rust-stack T43, ADR 0032). It creates
the records of document review items approved before approvals created them, insert-only under
`REV-<item id>`, tenant by tenant. Runbook and production rule: [docs/operations/review-materialize.md](../../../docs/operations/review-materialize.md)
(production only with the owner's word; dry run first).

```sh
cd engines && cargo build --release -p sipges-review-materialize
SIPGES_DATABASE_URL=… SIPGES_DATA_KEY=… target/release/review-materialize [--scope C/P] [--apply]
```

The TypeScript tool stays until the owner retires it; both write the same rows.

## Same as TypeScript

- Flags (`--scope`, `--apply`, `--help`, `--` ignored), parsed with Node's `parseArgs` rules; a
  parse error prints `Creación de registros de revisión fallida: TypeError` and exits 1.
- Dry run unless `--apply`; the usage text (exit 0 with `--help`, 2 for a malformed scope), the
  JSON report, the «Simulación» line, «El proyecto … no existe.» (exit 1) and exit 1 when a tenant
  has problems.
- Pending migrations are applied first (the SQL files are embedded at build time from
  `apps/api/src/platform/database/migrations`), and PostgreSQL notices are printed to stdout as
  postgres.js prints them.
- The same transactions: one per page of approved items, per `existing` lookup and per batch of
  up to 500 records of one module, each with its audit row. A run interrupted halfway leaves the
  batches already committed, and a re-run creates only what is missing.

## Known differences

| Case | TypeScript | Rust |
| --- | --- | --- |
| `SIPGES_DATABASE_URL` unset | embedded PGlite at `SIPGES_PGLITE_DIR` | refuses: `…fallida: Error`, exit 1 |
| Other API settings invalid (for example `SIPGES_PORT=x`) | `loadConfig` fails: `…fallida: Error`, exit 1 | ignored; only `SIPGES_DATA_KEY` and the URL are checked |
| TLS to a non-local host | encrypted, certificate not verified (`ssl: 'require'`) | encrypted and verified against the Mozilla roots |
| Unknown URL query parameters | passed to the server | rejected by rust-postgres (`…fallida: Error`) |
| Driver error names | the JavaScript class | `PostgresError` for server errors, `Error` otherwise |

## Differential test

`engines/tools-parity/review-materialize.ts` runs both tools on two copies of the same synthetic
database (every theme × status in three tenants, JavaScript-only whitespace, a 200+ unit id, an
edited record that must survive, 1,203 items for paging, and a trigger that interrupts the run
halfway) and compares exit code, stdout, stderr, `module_records`, `audit` and `record_versions`
after each of 21 steps. CI job: *Rust tools match the TypeScript tools* in `.github/workflows/rust.yml`.

```sh
cargo build -p sipges-review-materialize   # in engines/
SIPGES_TOOLS_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node engines/tools-parity/review-materialize.ts
```

The harness refuses any server that is not on a local host.
