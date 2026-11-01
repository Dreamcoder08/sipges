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
corepack pnpm e2e              # build the SPA + Playwright parity suite in Chromium (apps/e2e)
corepack pnpm --filter @sipges/api dev   # API on http://127.0.0.1:8000
corepack pnpm --filter @sipges/web dev   # SPA on http://127.0.0.1:5173 (proxies API routes)
```

### Test database lifecycle

API tests run with one Vitest worker and sequential files to bound PGlite's WASM memory. `createTestApp` registers each clone before configuration/bootstrap; an `afterEach` hook closes it even when setup or an assertion fails. The migrated template is retained only for its test file and closed in `afterAll`. Direct PGlite tests must call `trackTestDatabase(new PGlite())` immediately after allocation. Tests sharing this registry must not use `.concurrent`.

Do not raise Node's heap limit to hide missing fixture teardown. PGlite remains a single-connection test adapter; sequential test files do not replace the real-server concurrency checks below.

### Real PostgreSQL integration tests (optional)
Unit and HTTP tests use in-process PGlite (single connection). Concurrency, advisory locks and postgres.js typing are checked against a real server when `SIPGES_TEST_DATABASE_URL` is set; each run creates and drops a throwaway database. The integration suite also checks tenant isolation across two pools, rejected cross-tenant/identity access, role reset after rollback, concurrent tenant exports and serialized last-administrator protection. Missing credentials skip these checks; skipped tests are not security proof. Use synthetic local databases only.
```bash
docker run -d --rm --name sipges-pg-test -e POSTGRES_PASSWORD=<pw> -p 127.0.0.1:55432:5432 postgres:18-alpine
SIPGES_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:55432/postgres corepack pnpm --filter @sipges/api test
docker stop sipges-pg-test
```

End-to-end coverage, real-PostgreSQL option and the deployment checklist: [docs/deployment/readiness.md](../deployment/readiness.md).

## Layout
| Path | Purpose |
|---|---|
| `apps/api` | Hono HTTP server; `src/main.ts` is the composition root |
| `apps/api/src/contexts/<context>/{domain,application,infrastructure,http}` | Bounded contexts (ADR 0002) |
| `apps/api/src/platform` | Config, HTTP middleware, cross-cutting infrastructure |
| `apps/web` | React + Vite SPA (ADR 0006) |
| `apps/e2e` | Playwright end-to-end parity suite (T14) |
| `packages/contracts` | Zod schemas shared by API and SPA |
| `packages/kernel` | Shared kernel (`Result`, branded IDs) |

## Configuration
| Variable | Values | Default |
|---|---|---|
| `SIPGES_COOKIE_SECURE` | exactly `0` or `1` | unset → Secure cookies; any other value stops startup |
| `SIPGES_HOST` | bind address | `127.0.0.1` |
| `SIPGES_PORT` | 1–65535 | `8000` |
| `SIPGES_DATA_KEY` | base64 of exactly 32 bytes (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) | **required**; encrypts TOTP secrets at rest (ADR 0004) |
| `SIPGES_ADMIN_USERNAME` | lower-cased, trimmed | `admin` |
| `SIPGES_ADMIN_PASSWORD` | 12+ characters | required only on an empty installation |
| `SIPGES_ADMIN_FULL_NAME` | display name of the bootstrap admin | `Administrator` |
| `SIPGES_DATABASE_URL` | PostgreSQL URL; TLS required unless the host is local | unset → embedded PGlite (development only) |
| `SIPGES_PGLITE_DIR` | embedded database directory | `.data/pglite` |
| `SIPGES_TRUST_PROXY` | exactly `0` or `1`; `1` only behind a reverse proxy that sets `X-Forwarded-For` | `0` (socket address) |
| `SIPGES_MAX_UPLOAD_BYTES` | 1–104857600 | `10485760` (10 MiB); also bounds each document lab file |
| `SIPGES_STORAGE` | `local` or `s3` | `local` |
| `SIPGES_UPLOAD_DIR` | directory for `local` storage | `.data/uploads` |
| `SIPGES_S3_ENDPOINT` | HTTPS URL of an S3-compatible service (plain HTTP only for a local host) | required for `s3` |
| `SIPGES_S3_REGION` | signing region | `auto` |
| `SIPGES_S3_BUCKET` / `SIPGES_S3_ACCESS_KEY_ID` / `SIPGES_S3_SECRET_ACCESS_KEY` | bucket and credentials | required for `s3` |
| `SIPGES_OLLAMA_URL` | http(s) base URL of the Ollama embeddings server (T10) | `http://127.0.0.1:11434` |
| `SIPGES_OLLAMA_EMBED_MODEL` | embedding model | `nomic-embed-text` |
| `SIPGES_ANALYST_PROVIDER` | `anthropic` enables narrated briefings (ADR 0013); requires `ANTHROPIC_API_KEY` | unset (extractive only) |
| `SIPGES_ANALYST_MODEL` | Claude model for narrated briefings | `claude-opus-5-5` |
| `SIPGES_WEB_DIR` | built SPA to serve, e.g. `apps/web/dist` (docs/migration/web.md) | unset → API only |
| `SIPGES_REQUIRE_MFA` | exactly `0` or `1` | unset → every session must enroll TOTP before using the API (ADR 0009) |
| `SIPGES_ALLOWED_HOSTS` | comma-separated host names without port, e.g. `sipges.example.org` | unset → no Host check (local development); set it in every deployment (ADR 0009) |
| `NODE_ENV` | `production` requires `SIPGES_DATABASE_URL` (embedded PGlite is refused) | unset |

Migrations in `apps/api/src/platform/database/migrations/` run automatically at startup.

## Authentication behavior (T4)
- Passwords: Argon2id for new hashes; Python `pbkdf2_sha256$…` hashes still verify and are upgraded on the next successful login.
- Login throttling: 5 failures per username or 20 per client address within 15 minutes → `429` with `Retry-After: 900`. Attempts are reserved atomically, so parallel requests cannot exceed the limit.
- TOTP: a code (time step) can be used only once.
- Every state-changing request, including `/login` and `/logout`, must be same-origin when it carries an `Origin` header.
