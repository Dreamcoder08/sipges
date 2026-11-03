# apps/api-go

The Go backend of SIPGES ([ADR 0032](../../docs/adr/0032-go-backend-rust-engines.md)). It serves no
production route yet: routes move here one by one, each after a parity test against the TypeScript API.

## Layout

| Path                                | What it holds                                                            |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `cmd/api`                           | Composition root: configuration, pool, handler, graceful shutdown.       |
| `internal/app`                      | The handler: platform middleware, auth gates in order, routes.           |
| `internal/identity`                 | Session check, Origin and MFA gates, role gate (read-only).              |
| `internal/tenancy`                  | Grant cache, project scope, `GET /system/auth/current-scope`.            |
| `internal/identity/http/routes.go`  | `GET /system/auth/me` and `GET /system/auth/providers`.                  |
| `internal/audit`                    | `GET /system/audit`, the `GET /system/events` activity stream (SSE).     |
| `internal/prevention`               | Read routes of preventive plans: `actions`, `situation-room`, `summary`. |
| `internal/situations`               | `GET /system/v4/settings` and `GET /system/v4/situations` (read-only).   |
| `internal/reference`                | Project coordinates and canonical entities (embedded `data/*.json`).     |
| `internal/platform/config`          | Environment, validated at start (same names as `apps/api`).              |
| `internal/platform/database`        | pgx pool and the tenant transaction (`WithTenant`, `EnterTenant`).       |
| `internal/platform/database/dbtest` | Test-only scratch database with the `apps/api` migrations.               |
| `internal/platform/httpx`           | `{"detail": …}` errors, request id, access log, host allowlist, health;  |
|                                     | Hono-compatible path, cookie, query and Origin reading (`hono.go`).      |
| `internal/platform/logging`         | JSON `log/slog` logger that redacts secret-looking keys.                 |
| `Dockerfile`                        | Static image for Cloudflare Containers (port 8080, non-root).            |

Bounded contexts go in `internal/<context>/{domain,application,infrastructure,http}` when first used.

## Warm pool

`database.Open` keeps `DefaultMinConns` (2) connections open, created in the background at start, so
a request never waits for a new connection (170–230 ms from the container to Neon). A `pool_min_conns`
in `SIPGES_DATABASE_URL` overrides it, and it never exceeds `pool_max_conns`. Routing from the Worker: [the Go container guide](../../docs/deployment/go-container.md).

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

## Authentication and project scope

Every request passes the gates of the TypeScript API in its order (`apps/api/src/app.ts`):
host allowlist, session (`auth-middleware.ts`), project scope (`tenancy-middleware.ts`), role
gate. The Go API only verifies what TypeScript wrote: it reads `sessions`, `users`, `grants` and
`tenants` and never writes them. Sign-in, MFA enrolment, Google sign-in and API keys stay in
TypeScript until phase 4.

- Session: cookie `sipges_session`, 64 lower-case hex characters, looked up by its SHA-256 with
  `expires_at > now` (milliseconds, as JavaScript) and an active account. Public paths
  (`/health`, `/login`, …) skip it; machine paths (`/mcp`, `/hooks/*`, the cron) skip it and
  answer 404 until their routes move. Writes need `Origin` (or `Referer`) naming the Host.
  With `SIPGES_REQUIRE_MFA` (default on) a session without TOTP or Google sign-in gets the
  `mfa_required` 403.
- Scope: `X-SIPGES-Scope`, then cookie `sipges_scope`, then the only grant; a `project_id`
  query parameter or JSON body field naming another project is refused. Grants are cached for
  30 s per process, as in each TypeScript isolate.
- Handlers read tenant data with `tenancyhttp.WithRequestTenant(r, pool, fn)`: `WithTenant` with
  the resolved project, the session's username as `app.actor` and its role's clearance.

Paths, cookies, query parameters and headers are read the way Hono reads them
(`internal/platform/httpx/hono.go`), so both APIs decide the same: `CanonicalPath` rewrites the
path before any gate, and the gates and the router read that one string. `hono_cases_test.go`
was recorded from raw requests to Hono 4.13.14 on @hono/node-server 2.1.4; regenerate it when
either is upgraded. Where the port reads less than the WHATWG URL parser (an IDN or escaped
`Origin`, an invalid escape Go's server refuses with 400), it fails closed.

## Situations

`internal/situations` ports the read routes of `apps/api/src/contexts/situations`: the project
settings with their recommendation catalogue, and the situations report (records grouped by topic,
actor and territory, weighted by recency, with lessons). Both read `project_settings` and
`module_records` in the scope's tenant transaction, so a read-only account never sees records
marked `restringido`. `PUT /system/v4/settings` (admin-only, audited) stays in TypeScript.

The rules read stored JSON the way JavaScript does (`domain/js.go`): `String()` and number
formatting, `trim` and `\s`, full Unicode case mapping, UTF-16 ordering and lengths (a title cut
inside an emoji keeps the lone surrogate, as `JSON.stringify` writes it), `Math.round`, and the `$`
patterns of `replaceAll`. `0.5 ** e` is computed with 160 bits (`domain/pow.go`), because
`math.Pow` and Node differ in the last bit for one input in eight. `testdata/generate.mjs` records
the TypeScript routes' answers on synthetic scenarios (`fixtures.json`); rerun it after changing
either side (`--check` reports drift).

## Run

```sh
SIPGES_DATABASE_URL=postgres://… go run ./cmd/api        # listens on 127.0.0.1:8000
SIPGES_TEST_DATABASE_URL=postgres://sipges_test@127.0.0.1:55439/sipges_test go test -race ./...
go test -run '^$' -bench WithTenant ./internal/platform/database/   # with SIPGES_TEST_DATABASE_URL
golangci-lint run ./...                                  # v2.15.0
```

Parity with the TypeScript API (every route the Go API serves): `pnpm parity` from the repository root,
see [apps/parity](../parity/README.md).

Without `SIPGES_TEST_DATABASE_URL` the integration tests skip. With it, each run creates
`sipges_go_test_<random>`, applies every migration and drops the database at the end.
