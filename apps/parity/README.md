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

Add one or more entries to `CASES` in [`src/cases.ts`](src/cases.ts) when a route moves to Go, or, for a
bounded context, a module in [`src/contexts/`](src/contexts/index.ts) exporting its `cases` (names prefixed
with the context) and the synthetic `seed` SQL they read. [`src/fixtures.ts`](src/fixtures.ts) loads those
rows straight into the database after the migrations, together with a project nobody in the run is granted
(`PARITY/OTRO`), so a case can prove another project's rows stay invisible. Against two running APIs the
rows load only with `SIPGES_PARITY_SEED_DATABASE_URL`.

| Field        | Meaning                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `name`       | Unique name in the report.                                                           |
| `method`     | HTTP method.                                                                         |
| `path`       | Path and query, starting with `/`.                                                   |
| `headers`    | Extra request headers; `{origin}` becomes each API's own base URL.                   |
| `body`       | `{ json: … }`, `{ form: { … } }` or `{ raw: '…' }` (sent byte for byte).             |
| `rawTarget`  | Sends `path` exactly as written (dot segments, `\`), through `node:http`.            |
| `auth`       | `'admin'`, `'consulta'` or `'multi'`: that seeded user's session, sent to both APIs. |
| `sameOrigin` | `true` sends `Origin` set to each API's own base URL (same-origin write).            |
| `normalize`  | JSON paths that differ per run (`id`, `items.*.created_at`); fields only.            |

JSON compares as values: object key order does not count, `null` and a missing key differ. A normalized
path present on only one side is still a difference, and a path that names no field (`*`) is refused.

## Covered routes

| Route                                                           | Cases                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                   | plain, with a query string                                                                                                                                                                                                                                                                      |
| `GET /health/ready`                                             | database up                                                                                                                                                                                                                                                                                     |
| unknown paths (JSON 404)                                        | `/no-such-route` and `/health/` with a session                                                                                                                                                                                                                                                  |
| session and Origin gates                                        | 401 without a session or with an unknown one; 403 write without Origin                                                                                                                                                                                                                          |
| `GET /system/auth/current-scope`                                | 200 with a session; 403 for an ungranted project or `project_id`                                                                                                                                                                                                                                |
| JSON body project check                                         | 403 for a body or payload naming another project, also with a BOM, `1e400` or nesting deeper than 10,000 levels                                                                                                                                                                                 |
| `GET /system/auth/me`, `/providers`                             | no session, unknown session, a session; Google not configured                                                                                                                                                                                                                                   |
| project choice and role gate                                    | one grant automatic, two need a choice, `X-SIPGES-Scope`, the encoded scope cookie, an ungranted scope; `consulta` writing or in an admin-only area; `reset-mfa` needs a project                                                                                                                |
| request reading                                                 | encoded `project_id` key, undecodable `project_id`, two `Origin` headers                                                                                                                                                                                                                        |
| paths as Hono reads them                                        | `%2F`, dot segments (also `%2e`), `\`, trailing dot, `//` (JSON 404, not a redirect)                                                                                                                                                                                                            |
| `GET /system/audit`                                             | trail, limits and 422s, 401, 403 read-only role and ungranted project                                                                                                                                                                                                                           |
| `GET /system/prevention/actions`, `/situation-room`, `/summary` | each: a session, no session, `consulta`, an ungranted project (also `PARITY/OTRO`, whose plan has the default project's id), `project_id` of another and of its own project, `multi` before choosing, in the second project and in the first; plus a trailing slash and a `consulta` plan write |

The runner seeds `consulta` (read-only, one project) and `multi` (analista, two projects) through the
TypeScript API ([`src/seed.ts`](src/seed.ts)); the administrator keeps one project. Each project also gets a verified territorial alert and preventive plans (overdue, blocked by two parties, cancelled, in progress; one in the second project), so a read that crossed projects would differ. `/health/ready` with the database down (503), expiry, MFA, role gates and cross-tenant reads are
covered by each API's own tests (`apps/api-go/internal/app`). So is the `/system/events` stream, which parity
cannot compare. Rows of `PARITY/OTRO` are labelled, so a leak shows as a
difference.
