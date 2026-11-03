# apps/api-go

The Go backend of SIPGES ([ADR 0032](../../docs/adr/0032-go-backend-rust-engines.md)). It serves no
production route yet: routes move here one by one, each after a parity test against the TypeScript API.

## Layout

| Path                                | What it holds                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `cmd/api`                           | Composition root: configuration, pool, handler, graceful shutdown.      |
| `internal/platform/config`          | Environment, validated at start (same names as `apps/api`).             |
| `internal/platform/database`        | pgx pool and the tenant transaction (`WithTenant`, `EnterTenant`).      |
| `internal/platform/database/dbtest` | Test-only scratch database with the `apps/api` migrations.              |
| `internal/platform/httpx`           | `{"detail": …}` errors, request id, access log, host allowlist, health. |
| `internal/platform/logging`         | JSON `log/slog` logger that redacts secret-looking keys.                |

Bounded contexts go in `internal/<context>/{domain,application,infrastructure,http}` when first used.

## Tenant transaction

`WithTenant` sends the same statement as `apps/api/src/platform/database/tenant-transaction.ts`
and pipelines it with the work's first query: `tenant statement, Sync, first query, Sync` in one
write. The Sync in between keeps the TypeScript semantics: if entering fails, the first query gets
25P02 and returns nothing, and the failure to enter is the error reported. `pgx.Batch` cannot do
this (in every exec mode the second statement is skipped with the first one's error), so the
pipeline uses `pgconn` directly.

The first query is encoded as pgx's `QueryExecModeExec` does (no statement description, so no
extra round trip). Whatever that cannot express takes the ordinary pgx path after entering alone,
one round trip more but the same behaviour as a `pgx.Tx`:

- a first `Exec` without arguments (it may hold several statements, which only the simple
  protocol allows);
- `pgx.NamedArgs` and other query rewriters, exec-mode and result-format options;
- values that need the parameter types, such as a `map[string]any` for a `jsonb` column.

A panic in the work rolls the transaction back and releases the connection before it propagates.

Known limits: pgx's `QueryTracer` does not see the pipelined first query, and a test run killed
by `-timeout` skips the drop of its scratch database (`sipges_go_test_*`).

## Run

```sh
SIPGES_DATABASE_URL=postgres://… go run ./cmd/api        # listens on 127.0.0.1:8000
SIPGES_TEST_DATABASE_URL=postgres://sipges_test@127.0.0.1:55439/sipges_test go test -race ./...
go test -run '^$' -bench WithTenant ./internal/platform/database/   # with SIPGES_TEST_DATABASE_URL
golangci-lint run ./...                                  # v2.15.0
```

Without `SIPGES_TEST_DATABASE_URL` the integration tests skip. With it, each run creates
`sipges_go_test_<random>`, applies every migration and drops the database at the end.
