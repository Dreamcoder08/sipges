# 0001 — Monorepo and toolchain

## Context
SIPGES has a backend, a frontend and contracts both must agree on. The Python app keeps them in one file plus static assets, so contracts drift silently (e.g. the UI project switch never reaches the server).

## Decision
- **pnpm workspaces** (via Corepack, version pinned in `packageManager`); `pnpm -r` runs tasks in topological order.
- **TypeScript 7** (native compiler) for typechecking every package, strict everywhere (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`), ESM only, Node ≥ 22 (Node 24 runs `.ts` directly via type stripping).
- **TypeScript 6** at the workspace root only, because ESLint and dependency-cruiser need the JavaScript compiler API that TypeScript 7 does not publish yet.
- **ESLint** (typescript-eslint strict) + **Prettier**.
- **Vitest** for unit/integration tests, **Playwright** for end-to-end.
- **dependency-cruiser** enforces the hexagonal dependency rule (ADR 0002) through `scripts/check-boundaries.mjs`, which first proves a fixture violation is detected and fails if zero modules are cruised.
- Layout:
  ```
  apps/api            Hono HTTP server (composition root)
  apps/web            React + Vite SPA
  packages/contracts  Zod schemas + inferred types shared by api and web
  packages/kernel     Shared kernel: Result, branded IDs, Clock, errors
  ```
- Python app stays at repo root, untouched, as the executable reference until cutover (T14).

## Amendment (T3)
Turborepo and Biome were dropped: on this development machine Windows refuses to execute their unsigned native binaries (`spawn UNKNOWN` / `Permission denied`), and bypassing an OS application-control policy is not acceptable. Both are replaced by pure-JavaScript tools. dependency-cruiser with TypeScript 7 silently cruised 0 modules and reported success, which is why the boundary script refuses vacuous passes.

## Consequences
- One `pnpm install`, one `pnpm check` (lint, boundaries, typecheck, test).
- Contract changes break compilation on both sides instead of at runtime.
- Contributors need Node ≥ 22 and Corepack; no global pnpm install.

## References
pnpm workspaces, TypeScript `tsconfig` reference, typescript-eslint, dependency-cruiser.

## Addendum (2026-11-01): Bun evaluated, pnpm kept

The owner asked whether Bun would be better than pnpm. Decision: keep pnpm for now.

- The slow part of local verification is the test suites (Vitest, PGlite) and typecheck, not package
  installs, so a faster installer does not shorten the loop. `pnpm verify:fast` (affected packages, static
  checks in parallel) addresses the actual cost.
- Production runs on Cloudflare Workers (`workerd`), not on Node or Bun, so a runtime switch brings no
  production gain; moving tests to `bun test` would mean rewriting the Vitest, MSW and Testing Library setup.
- pnpm's strict layout and `minimumReleaseAge` already protect the supply chain. Bun 1.3 offers a release-age
  gate and isolated installs too, so this is no longer a differentiator, but swapping the package manager and
  lockfile of a deployed monorepo is a delivery change with its own risk.

Revisit when: Workers tooling or Vitest gains first-class Bun support that removes a measured bottleneck, or a
spike on one package shows a material gain in the verification loop.
