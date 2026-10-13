# TypeScript workspace

The TypeScript rewrite lives next to the Python reference app (see `docs/adr/0001-monorepo-and-toolchain.md`).

## Requirements
- Node.js ≥ 22 (Node 24 recommended: runs `.ts` files directly with type stripping).
- Corepack (bundled with Node). Do not install pnpm globally; the version is pinned in `package.json`.

## Commands
```bash
corepack pnpm install          # install all workspaces
corepack pnpm check            # ESLint + Prettier, architecture boundaries, typecheck, tests
corepack pnpm test             # tests only (all workspaces)
corepack pnpm boundaries       # hexagonal dependency rules (dependency-cruiser)
corepack pnpm --filter @mascli/api dev   # API on http://127.0.0.1:8000
corepack pnpm --filter @mascli/web dev   # SPA on http://127.0.0.1:5173 (proxies API routes)
```

### Test database lifecycle

API tests run with one Vitest worker and sequential files to bound PGlite's WASM memory. `createTestApp` registers each clone before configuration/bootstrap; an `afterEach` hook closes it even when setup or an assertion fails. The migrated template is retained only for its test file and closed in `afterAll`. Direct PGlite tests must call `trackTestDatabase(new PGlite())` immediately after allocation. Tests sharing this registry must not use `.concurrent`.

Do not raise Node's heap limit to hide missing fixture teardown. PGlite remains a single-connection test adapter; sequential test files do not replace the real-server concurrency checks below.

### Real PostgreSQL integration tests (optional)
Unit and HTTP tests use in-process PGlite (single connection). Concurrency, advisory locks and postgres.js typing are checked against a real server when `MASCLI_TEST_DATABASE_URL` is set; each run creates and drops a throwaway database. The integration suite also checks tenant isolation across two pools, rejected cross-tenant/identity access, role reset after rollback, concurrent tenant exports and serialized last-administrator protection. Missing credentials skip these checks; skipped tests are not security proof. Use synthetic local databases only.
```bash
docker run -d --rm --name mascli-pg-test -e POSTGRES_PASSWORD=<pw> -p 127.0.0.1:55432:5432 postgres:18-alpine
MASCLI_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:55432/postgres corepack pnpm --filter @mascli/api test
docker stop mascli-pg-test
```

## Layout
| Path | Purpose |
|---|---|
| `apps/api` | Hono HTTP server; `src/main.ts` is the composition root |
| `apps/api/src/contexts/<context>/{domain,application,infrastructure,http}` | Bounded contexts (ADR 0002) |
| `apps/api/src/platform` | Config, HTTP middleware, cross-cutting infrastructure |
| `apps/web` | React + Vite SPA (ADR 0006) |
| `packages/contracts` | Zod schemas shared by API and SPA |
| `packages/kernel` | Shared kernel (`Result`, branded IDs) |

## Configuration
| Variable | Values | Default |
|---|---|---|
| `MASCLI_COOKIE_SECURE` | exactly `0` or `1` | unset → Secure cookies; any other value stops startup |
| `MASCLI_HOST` | bind address | `127.0.0.1` |
| `MASCLI_PORT` | 1–65535 | `8000` |
| `MASCLI_DATA_KEY` | base64 of exactly 32 bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) | **required**; encrypts TOTP secrets at rest (ADR 0004) |
| `MASCLI_ADMIN_USERNAME` | lower-cased, trimmed | `admin` |
| `MASCLI_ADMIN_PASSWORD` | 12+ characters | required only on an empty installation |
| `MASCLI_ADMIN_FULL_NAME` | display name of the bootstrap admin | `Administrator` |
| `MASCLI_DATABASE_URL` | PostgreSQL URL; TLS required unless the host is local | unset → embedded PGlite (development only) |
| `MASCLI_PGLITE_DIR` | embedded database directory | `.data/pglite` |
| `MASCLI_TRUST_PROXY` | exactly `0` or `1`; `1` only behind a reverse proxy that sets `X-Forwarded-For` | `0` (socket address) |
| `MASCLI_MAX_UPLOAD_BYTES` | 1–104857600 | `10485760` (10 MiB); also bounds each document lab file |
| `MASCLI_STORAGE` | `local` or `s3` | `local` |
| `MASCLI_UPLOAD_DIR` | directory for `local` storage | `.data/uploads` |
| `MASCLI_S3_ENDPOINT` | HTTPS URL of an S3-compatible service (plain HTTP only for a local host) | required for `s3` |
| `MASCLI_S3_REGION` | signing region | `auto` |
| `MASCLI_S3_BUCKET` / `MASCLI_S3_ACCESS_KEY_ID` / `MASCLI_S3_SECRET_ACCESS_KEY` | bucket and credentials | required for `s3` |
| `MASCLI_OLLAMA_URL` | http(s) base URL of the Ollama embeddings server (T10) | `http://127.0.0.1:11434` |
| `MASCLI_OLLAMA_EMBED_MODEL` | embedding model | `nomic-embed-text` |
| `NODE_ENV` | `production` requires `MASCLI_DATABASE_URL` (embedded PGlite is refused) | unset |

Migrations in `apps/api/src/platform/database/migrations/` run automatically at startup.

## Authentication behavior (T4)
- Passwords: Argon2id for new hashes; Python `pbkdf2_sha256$…` hashes still verify and are upgraded on the next successful login.
- Login throttling: 5 failures per username or 20 per client address within 15 minutes → `429` with `Retry-After: 900`. Attempts are reserved atomically, so parallel requests cannot exceed the limit.
- TOTP: a code (time step) can be used only once.
- Every state-changing request, including `/login` and `/logout`, must be same-origin when it carries an `Origin` header.
