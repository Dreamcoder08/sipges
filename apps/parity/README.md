# apps/parity

The Go/TypeScript parity runner ([ADR 0032 §6](../../docs/adr/0032-go-backend-rust-engines.md)): a route
moves to the Go API only while the same request gives the same status, media type and JSON from both APIs.

## Run

```sh
# Starts both APIs on a throwaway database of this synthetic server and drops it at the end.
SIPGES_PARITY_DATABASE_URL=postgres://sipges_test@127.0.0.1:55439/sipges_test pnpm parity

# Or targets two APIs already running on the same synthetic database.
SIPGES_PARITY_TS_URL=http://127.0.0.1:8000 SIPGES_PARITY_GO_URL=http://127.0.0.1:8001 \
SIPGES_PARITY_ADMIN_USERNAME=… SIPGES_PARITY_ADMIN_PASSWORD=… pnpm parity
```

With a database server, the runner creates `sipges_parity_<random>`, starts `apps/api/src/main.ts` (which
applies the migrations and seeds a synthetic administrator with a password generated for the run), builds
and starts `apps/api-go`, signs in through the TypeScript API and sends every case to both. It exits 1 on
any difference and prints each one (`status`, `content-type`, or the JSON path with both values).
A case without an answer in 15 s fails, an API that cannot start or dies before it is ready fails at once
(with its exit code or signal), and Ctrl-C or a cancelled job still stops both APIs and drops the database.
CI runs it in the `Go/TypeScript parity` job of `.github/workflows/go.yml`.

## Adding a route

Add one or more entries to `CASES` in [`src/cases.ts`](src/cases.ts) when a route moves to Go:

| Field       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `name`      | Unique name in the report.                                                |
| `method`    | HTTP method.                                                              |
| `path`      | Path and query, starting with `/`.                                        |
| `headers`   | Extra request headers.                                                    |
| `body`      | `{ json: … }` or `{ form: { … } }`.                                       |
| `auth`      | `'admin'` sends the synthetic administrator's session to both APIs.       |
| `normalize` | JSON paths that differ per run (`id`, `items.*.created_at`); fields only. |

JSON compares as values: object key order does not count, `null` and a missing key differ. A normalized
path present on only one side is still a difference, and a path that names no field (`*`) is refused.

## Covered routes

| Route                    | Cases                                          |
| ------------------------ | ---------------------------------------------- |
| `GET /health`            | plain, with a query string                     |
| `GET /health/ready`      | database up                                    |
| unknown paths (JSON 404) | `/no-such-route` and `/health/` with a session |

Known difference, not covered: without a session, unknown paths answer 401 in TypeScript and 404 in Go
until identity moves to Go (phase 4); such paths stay on TypeScript. `/health/ready` with the database
down (503) is covered by each API's own tests.
