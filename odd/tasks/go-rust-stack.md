# Go backend, Rust engines and tools

Move the backend (APIs, agents, queues) to Go and the engines and scripts to Rust, keeping the TypeScript
frontend, by strangling the TypeScript API route by route behind parity tests (ADR 0032). Branch per task from
`main`; delivery `auto-chain` (one PR per task, merged after CI); runners `go test`, `cargo test`, Vitest for the web
and the parity runner.

## Specs

- S1 — «hey bro estaba pensando en hacer todo el backend en go por cuestion de recursos»
- S2 — «quiero que el backend , APIS , agentes , colas sean en go»
- S3 — «quiero que el proyecto usa el siguiente stack , el frontend typescript , el backend go , scripts/motor rust»
- S4 — «cuestiona con informacion actualizada de esta semana , mes en la web 2026 »
- S5 — «quiero este mejor,  Cloudflare containers»
- S6 — Same PostgreSQL schema, row-level security and tenant transaction contract (ADR 0003); a Go route ships only with a parity test against the TypeScript route (same request → same status and JSON) and the existing isolation tests ported.
- S7 — No route switches to Go in production before its parity test, CI and an owner-visible measurement pass; the thesis delivery is not put at risk.
- S8 — Hosting gate (ADR 0032 §4): a Go container in Cloudflare Containers with `regions = ["ENAM"]` opens TLS TCP to Neon and cold starts ≤ 3 s. The original p50 ≤ 10 ms / p95 ≤ 25 ms target failed (p50 26–33 ms); the owner chose «me quedo con Cloudflare Containers», so the target is warm p50 ≤ 35 ms and p95 ≤ 45 ms, with Fly.io `iad` as the fallback if a later measurement exceeds it.

## Tasks

Phase 0 — foundations (no production traffic):
- T1 [x] — S3–S5, S8: ADR 0032 and this plan. Route: inline. PR #202.
- T2 [x] — S8 (PR #207; gate (b) failed, owner kept Cloudflare Containers, see L5): spike: minimal Go container (`/health`, `/db-ping`) deployed with ENAM constraint, measure TCP connect, TLS, query p50/p95 and cold start against Neon; record numbers in ADR 0032. Needs the owner's Cloudflare/Neon credentials in the deploy environment (no secrets in the repo).
- T3 [x] — S2, S6 (PR #203): `apps/api-go` skeleton: module layout per context, config, structured logging, `pgx` pool, tenant transaction (`withTenant` equivalent with the single set_config statement, pipelined first query, typed parameters), request context, error contract (ADR 0007), health/readiness. Port the tenant isolation tests (RLS, cross-tenant, role reset) against the synthetic PostgreSQL.
- T4 [x] — S3 (PR #206): Rust workspace `engines/` → `wasm32-wasip1`, loaded in Go with `wazero`; first engine: indicators + IRSA, with parity against the TypeScript engine on the synthetic fixtures (`python-parity` style).
- T5 [x] — S6 (L6): parity runner (pnpm): same synthetic database, same requests against the TypeScript API and the Go API, diff status and JSON; CI job. Route: inline.
- T6 [ ] — S2, S5: Worker routing: route list deciding TypeScript or Go per route, off by default; container binding with ENAM constraint; CI builds and pushes the image.
- T7 [x] — CI (`go.yml` with T3, `rust.yml` with T4): Go (`go vet`, tests, `golangci-lint`) and Rust (`cargo fmt --check`, `clippy`, tests, wasm build) jobs.

Phase 1 — read-only, low-risk contexts (switch per route after parity): reference, system/health, audit (read), management, geography, indicators (Rust engine), analytics (Rust engines), situations, prevention.

Phase 2 — records and documents: records (lists, summary, import), evidence (R2), documents (PDF/DOCX; Rust where it pays), ontology, intelligence (embeddings, egress guard), analyst (AI, egress guard).

Phase 3 — agents and queues: automation (rules, runs, settle-window cursor, deliveries, push), integration (feeds, webhooks, ingest keys), long-lived workers in a container woken by cron.

Phase 4 — highest risk, each with an independent verifier: privacy, tenancy (grants, scope resolution), identity (argon2id + legacy PBKDF2 hashes, TOTP, sealed secrets, sessions, Google sign-in, API keys) — byte-compatible with existing stored data.

Phase 5 — Rust tools and retirement: `migrate-legacy`, `import:base-maestra`, `rotate-data-key`, `review-materialize` as Rust binaries; remove the TypeScript API once every route is served by Go; update ADR 0028 and the deployment guide.

## Log

- L1 — Requests (2026-11-03), verbatim: «hey bro estaba pensando en hacer todo el backend en go por cuestion de recursos»; «quiero que el backend , APIS , agentes , colas sean en go»; «quiero que el proyecto usa el siguiente stack , el frontend typescript , el backend go , scripts/motor rust»; on hosting «cuestiona con informacion actualizada de esta semana , mes en la web 2026 » and then «quiero este mejor,  Cloudflare containers».
- L2 — Advice given before the decision: latency is round trips, not CPU (39 s wall, 10 ms CPU in production); Workers cannot run Go natively; ADR 0005's gate had not tripped. The owner kept the decision; this plan executes it safely.
- L3 — Research (2026-11-03): Cloudflare Containers placement constraints (`regions`, `jurisdiction`) exist; outbound raw TCP and Hyperdrive from containers are undocumented → spike T2 gates the migration. Fly.io `iad` (USD 2.19/month per 256 MB Machine since 2026-10-01) is the fallback. Neon São Paulo exists but region changes need a data migration and no Lima measurement favours it.
- L4 — Size (main at 23c404f): about 26,000 lines of TypeScript in 20 API contexts and about 200 routes; largest: integration, automation, analytics, documents, ontology, identity.
- L5 — Spike T2 (PR #207, 2026-11-03): TLS to Neon and cold start pass; warm p50 26–33 ms (best 18.8 ms) fails the 10 ms target; `ENAM` lands in Toronto, Miami or Atlanta. Owner decision, verbatim: «me quedo con Cloudflare Containers». Target relaxed to p50 ≤ 35 ms / p95 ≤ 45 ms; Fly.io `iad` remains the fallback. Next: T5 parity runner, then T6 Worker routing and container binding; T7 CI landed with T3 (`go.yml`) and T4 (`rust.yml`).
- L6 — T5 parity runner (2026-11-03): `apps/parity` (`pnpm parity`) creates `sipges_parity_<random>` on a synthetic PostgreSQL server, starts `apps/api/src/main.ts` (migrations, synthetic administrator with a per-run password) and a fresh build of `apps/api-go` on it, signs in through TypeScript and sends each case of `src/cases.ts` to both; it diffs status, media type and JSON by value, normalizing only the paths a case names. Covered: `GET /health` (plain, with query), `GET /health/ready`, the JSON 404 (`/no-such-route`, `/health/` with a session) — 5/5 locally against PostgreSQL 17 at 127.0.0.1:55439. Detection checked by adding an unauthenticated `/no-such-route` case: TypeScript 401 «Inicie sesión para acceder a SIPGES» vs Go 404 «Not Found», exit 1. That gap stays until identity moves (phase 4): the Worker must keep unauthenticated traffic on TypeScript. CI: job `Go/TypeScript parity` in `go.yml`, whose path filter now includes `apps/api/src`, `apps/parity`, `packages` and the lockfile. Next: T6 Worker routing.
