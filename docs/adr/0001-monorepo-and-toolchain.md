# 0001 — Monorepo and toolchain

## Context
MASCLI has a backend, a frontend and contracts both must agree on. The Python app keeps them in one file plus static assets, so contracts drift silently (e.g. the UI project switch never reaches the server).

## Decision
- **pnpm workspaces** (via Corepack, version pinned in `packageManager`) + **Turborepo** for cached, dependency-aware tasks.
- **TypeScript strict** everywhere (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), ESM only, Node ≥ 22 LTS.
- **Biome** for lint + format (single fast tool; replaces ESLint + Prettier).
- **Vitest** for unit/integration tests, **Playwright** for end-to-end.
- **dependency-cruiser** enforces the hexagonal dependency rule (ADR 0002) in CI.
- Layout:
  ```
  apps/api            Hono HTTP server (composition root)
  apps/web            React + Vite SPA
  packages/contracts  Zod schemas + inferred types shared by api and web
  packages/kernel     Shared kernel: Result, branded IDs, Clock, errors
  ```
- Python app stays at repo root, untouched, as the executable reference until cutover (T14).

## Consequences
- One `pnpm install`, one `pnpm turbo run check` (typecheck, lint, test, boundaries).
- Contract changes break compilation on both sides instead of at runtime.
- Contributors need Node ≥ 22 and Corepack; no global pnpm install.

## References
pnpm workspaces, Turborepo docs, Biome docs, TypeScript `tsconfig` reference, dependency-cruiser.
