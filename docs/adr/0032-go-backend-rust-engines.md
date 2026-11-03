# 0032 — Go backend, Rust engines and tools, TypeScript frontend

## Status
Accepted (2026-11-03). Supersedes [0005](0005-processing-ports-and-native-adapters.md). Amends
[0028](0028-cloudflare-workers-hosting.md): Cloudflare stays in front, the backend moves off Workers.

## Context
The owner set the target stack: «quiero que el proyecto usa el siguiente stack , el frontend typescript , el backend go , scripts/motor rust» and, for the backend, «quiero que el backend , APIS , agentes , colas sean en go».

On hosting the owner chose, after comparing options: «quiero este mejor,  Cloudflare containers».

Measured and documented facts that shape how, not whether:
- Latency is dominated by round trips, not CPU: a production request spent 39 s waiting with 10 ms of CPU; each query paid Lima ↔ us-east-1 (~130 ms). The gains so far came from removing round trips (odd/tasks/backend-latency.md, L5–L15).
- Cloudflare Workers does not run Go natively (only through WebAssembly), so a Go backend needs another host.
- Cloudflare Containers (Workers Paid, USD 5/month base; billed per 10 ms of activity) run by default near the request, but accept placement constraints: `regions` among ENAM, WNAM, EEUR, WEUR, APAC, SAM, … (containers/concepts/placement, read 2026-11-03). `ENAM` keeps them in eastern North America, near Neon us-east-1, without pinning a city.
- The Containers docs cover outbound HTTP/HTTPS (`enableInternet`, default true) but do not state whether raw TCP to PostgreSQL (port 5432) is allowed, nor whether Hyperdrive is reachable from a container (containers/configuration/outbound-traffic, containers/faq, read 2026-11-03).
- Containers have no maximum runtime; an instance sleeps after inactivity (`sleepAfter`, 10 minutes by default) and cold starts are typically 1–3 s.
- Fly.io runs Machines in a chosen region, including `iad` (Ashburn), next to Neon `aws-us-east-1`; a 256 MB shared-CPU Machine costs USD 2.19/month since 2026-10-01 (fly.io/pricing). It is the evaluated fallback.
- Neon offers `aws-sa-east-1` (São Paulo), but a project's region cannot change, and no Lima measurement shows São Paulo is closer than Ashburn.

## Decision
1. **Frontend** stays TypeScript (`apps/web`, React/Vite), unchanged.
2. **Backend in Go** (`apps/api-go`): HTTP APIs, identity, tenancy, agents, queues and automation workers. Same bounded contexts and hexagonal layout as [0002](0002-hexagonal-architecture-and-bounded-contexts.md): `internal/<context>/{domain,application,infrastructure,http}`, manual dependency injection in one composition root, no context importing another's internals.
3. **Engines and tools in Rust**: the pure computation engines (indicators and IRSA, situational, consensus, strategic, integrated analysis, conflict-risk prediction, candidate links, text analysis) as one Rust workspace compiled to WebAssembly (`wasm32-wasip1`) and run inside the Go process with `wazero` (pure Go, no cgo). Operator tools (`migrate-legacy`, `import:base-maestra`, `rotate-data-key`, `review-materialize`) become Rust command-line binaries.
4. **Hosting**: the Go backend runs in **Cloudflare Containers** with `constraints.regions = ["ENAM"]`, next to Neon us-east-1 (no data migration). The existing Worker stays in front: it serves the web build and routes `/api` and `/system` either to the TypeScript backend or to the Go container, route by route. Long-lived queue workers run in a container instance woken by the Worker's cron trigger.
   - **Gate before any migration (spike S0):** a minimal Go container deployed with that constraint must (a) open a TCP connection to Neon with TLS, (b) show a warm query round trip p50 ≤ 10 ms and p95 ≤ 25 ms to Neon, (c) cold start ≤ 3 s, measured and recorded. If (a) fails, try Neon's pooled endpoint and Hyperdrive; if none works or (b) fails, fall back to Fly.io `iad` with the same container image, recorded in this ADR.
   - A move of both database and backend to São Paulo is considered only after a measured Lima comparison.
5. **Same database, same rules**: PostgreSQL schema, row-level security and the tenant transaction contract ([0003](0003-persistence-and-tenant-isolation.md)) do not change. Go enters a tenant with the same single statement (`set_config` for `app.tenant_id`, `app.actor`, `app.clearance` and `role`) and keeps the same isolation tests. Migrations stay plain SQL files with one migrator at a time.
6. **Strangler migration, not a rewrite**: the TypeScript API keeps serving until each route has a Go replacement that passes a parity test against it (same request, same status, same JSON), as the TypeScript port did against the Python reference. A route list in the proxy decides which origin serves each route; switching a route back is a configuration change. The TypeScript backend is removed only when the last route moved.
7. **Queues** stay in PostgreSQL (`FOR UPDATE SKIP LOCKED` claims, unique runs, settle-window cursor) with long-lived Go workers; no new queue infrastructure until a measurement needs it.

## Consequences
- Three toolchains in CI: pnpm (web, contracts, parity runner), Go (`go vet`, tests, `golangci-lint`), Rust (`cargo fmt`, `clippy`, tests, wasm build). Dependencies are pinned; the release-age rule of pnpm applies in spirit to Go modules and crates.
- Byte-compatible security primitives are a hard requirement before identity moves: password hashes (argon2id and the legacy PBKDF2 format), TOTP, sealed secrets under `SIPGES_DATA_KEY`, session token hashing and cookies. Identity and tenancy move last, each with an independent verifier.
- Contracts: `packages/contracts` (Zod) remains the source of truth for the web; the Go side is tested against the same JSON fixtures, so drift fails the parity run.
- New operational surface: a container image (built in CI and pushed with `wrangler deploy`), its secrets through Worker secrets (database URL, data key, VAPID keys), health checks and the `sleepAfter`/cold-start trade-off; deploys stay automatic from `main` after CI. One container image keeps the Fly.io fallback a hosting change, not a code change.
- The thesis delivery is not put at risk: no route switches to Go in production until its parity test, CI and an owner-visible measurement pass.

## References
- Measurements: odd/tasks/backend-latency.md; docs/benchmarks/README.md.
- Fly.io pricing and regions: https://fly.io/pricing/ , https://fly.io/docs/reference/regions/
- Cloudflare Containers: https://developers.cloudflare.com/containers/pricing/ , https://developers.cloudflare.com/containers/concepts/placement/ , https://developers.cloudflare.com/containers/configuration/outbound-traffic/ , https://developers.cloudflare.com/containers/faq/
- Neon regions: https://neon.com/docs/introduction/regions
- wazero: https://github.com/tetratelabs/wazero
