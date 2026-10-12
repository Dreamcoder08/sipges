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
