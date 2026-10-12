# TypeScript Hexagonal Migration

Rewrite MASCLI RC 3.0 (Python/FastAPI, 65 endpoints, vanilla JS frontend) as a TypeScript monorepo with hexagonal architecture, using the Python app only as the behavioral specification.
Branch `feature/typescript-hexagonal-migration` from `c7fec1b` (Python P2b committed). Python branch stays untouched as reference; no push, PR, deployment or real-data migration without explicit user decision.

## Specs
- S1: "Abrir un ODD nuevo para migrar a TypeScript"
- S2: "quiero todo de vanguardia arquitectura hexagonal , patrones de diseño , system deisng"
- S3: "buenas practicas senior de frontend , buenas practicas senior de backend"
- S4: "rust o go para eficiencia donde deba haber enfocado en performance , escalabilidad" — user decision: "Solo con un benchmark que lo justifique (Recomendado)": hexagonal port for heavy processing; Go/Rust adapter only when a measured bottleneck justifies it.
- S5: "y mas buenas practicas y filosofia de gentleman , e inspirandote de los mejores del mundo , y del cdoigo abierto y mas informacion disponible"
- S6: User decisions: migration "Desde cero (Recomendado)" using current Python as behavioral specification (cousin's version not used); stack "Monorepo pnpm + Hono + React/Vite (Recomendado)" (Turborepo, Hono + Zod, React 19 + Vite + TanStack Query/Router, PostgreSQL + Drizzle, Vitest/Playwright).
- S7: Behavioral parity: existing security behavior (tenant-scoped export, MFA enrollment guard, Secure-by-default cookies with exact `0|1` override, tenant isolation 403/404) must be preserved and covered by tests.

## Tasks
- T1 [x] S6,S7 — Behavioral contract inventory of Python app (endpoints, auth/MFA/tenancy, data files, DOCX/PDF/CSV outputs) → `docs/migration/behavior-contract.md`; route: gentle-ai-explore + inline doc; commit: see L6
- T2 [ ] S2,S4,S5 — ADRs: bounded contexts, hexagonal layout, tenant isolation strategy, persistence, document generation, Go/Rust port policy → `docs/adr/`; route: research + inline; commit: pending
- T3 [ ] S2,S3,S6 — Monorepo skeleton (pnpm workspaces, Turborepo, strict TS, lint/format, Vitest, `apps/api`, `apps/web`, `packages/*`) with architecture boundary checks; route: inline; commit: pending
- T4 [ ] S2,S3,S7 — Identity context: accounts, password hashing, sessions, Secure cookies, TOTP MFA, login throttling; parity tests; route: writer; commit: pending
- T5 [ ] S2,S7 — Tenancy context: scopes, grants, scope selection, tenant isolation, scoped export; route: writer; commit: pending
- T6 [ ] S2,S3 — Generic module records CRUD (`/api/{module}`) and audit trail; route: writer; commit: pending
- T7 [ ] S2,S3 — IRSA, indicators and analysis engines (situational, strategic, integrated, consensus); route: writer; commit: pending
- T8 [ ] S2,S4 — Uploads via object-storage port (local + S3-compatible adapters); route: writer; commit: pending
- T9 [ ] S2,S4 — Document lab and DOCX/CSV report generation behind a processing port; route: writer; commit: pending
- T10 [ ] S2,S3 — Intelligence, prevention and management contexts; route: writer; commit: pending
- T11 [ ] S3 — Frontend rewrite (React/Vite, feature-based structure, typed API client, accessibility, no inline handlers); route: writer; commit: pending
- T12 [ ] S4 — Benchmarks of processing hotspots; Go/Rust adapter only if justified; route: inline; commit: pending
- T13 [ ] S6,S7 — SQLite → PostgreSQL migration tooling validated on synthetic data only; route: writer; commit: pending
- T14 [ ] S3,S7 — End-to-end parity (Playwright) and deployment readiness docs; route: verify; commit: pending

## Log
- L1 (user, original request): "Crea odd o continua con el odd para que continues desde la rama de mi repo de github del proyecto en la que se tenia que hacer casi todo con typescript o stack de vanguardia"
- L2 (evidence): Remote `Dreamcoder08/mascli` has only `feature/python-free-hosting-preparation` and `feature/secure-mascli-public-deployment`; neither contains TypeScript. Prior ODD preserved Python and excluded the cousin's migration.
- L3 (user): "Abrir un ODD nuevo para migrar a TypeScript , quiero todo de vanguardia arquitectura hexagonal , patrones de diseño , system deisng , buenas practicas senior de frontend , buenas practicas senior de backend , rust o go para eficiencia donde deba haber enfocado en performance , escalabilidad y mas buenas practicas y filosofia de gentleman , e inspirandote de los mejores del mundo , y del cdoigo abierto y mas informacion disponible"
- L4 (user decisions): P2b "Commitear P2b en la rama Python (Recomendado)"; cousin "Desde cero (Recomendado)"; stack "Monorepo pnpm + Hono + React/Vite (Recomendado)"; Rust/Go "Solo con un benchmark que lo justifique (Recomendado)".
- L5 (evidence): P2b committed `c7fec1b` on Python branch (18 cookie tests passed, diff check clean; native review still unfinished). Toolchain: Node v24.19.0, Go 1.27.0, Docker 29.7.2; pnpm not installed (use corepack); Rust toolchain absent. Engram unavailable (outdated binary) — mirror `odd/typescript-hexagonal-migration/tasks` pending.
- L6 (evidence): T1 done. Read-only gentle-ai-explore inventory (S6, S7 covered; app.py read fully, app.js partially) → `docs/migration/behavior-contract.md`: 65 routes, middleware order, PBKDF2 310k, TOTP, tenancy, 4 lazy tables, 11 candidate bounded contexts, hotspots, 13 open product decisions (§8). Engram mirror still unavailable.
- L7 (user decision for T2): "(Recomendado)" — preserve user-visible contracts (endpoints, responses, roles, calculations) and fix the §8 defects of `docs/migration/behavior-contract.md` in the TypeScript version, each with its own ADR and test.
- L8 (evidence): RDD stop hook proposed START over accumulated range `c442ebf..HEAD` (lineage `review-2edff5816b6a18f8`). Not run: review candidates are work units, not the accumulated branch; session commits `46ecea8`/`5a418fd` are docs-only; P2b `c7fec1b` already has stuck lineage `review-5bfc99a047e473bc` (operation_timeout). Facade ASSESS returned unassessable (no pending changes).
