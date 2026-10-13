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

Migrations in `apps/api/src/platform/database/migrations/` run automatically at startup.

## Authentication behavior (T4)
- Passwords: Argon2id for new hashes; Python `pbkdf2_sha256$…` hashes still verify and are upgraded on the next successful login.
- Login throttling: 5 failures per username or 20 per client address within 15 minutes → `429` with `Retry-After: 900`.
- TOTP: a code (time step) can be used only once.
- Every state-changing request, including `/login` and `/logout`, must be same-origin when it carries an `Origin` header.
