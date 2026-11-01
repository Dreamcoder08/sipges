# ADR 0028 — Cloudflare Workers as the host, through Hyperdrive to PostgreSQL

- Status: Accepted. Originally an optional host; since [ADR 0029](0029-retire-vercel-host.md) it is the only host.
- Date: 2026-10-31
- Task: `odd/tasks/cloudflare-workers.md` (T1–T5)

## Context

SIPGES ran its Hono API and React SPA on Node, published on Vercel. The owner asked why not
Cloudflare and chose «Cloudflare Workers + Hyperdrive + Neon». The data must stay in PostgreSQL
with forced row-level security, so D1 (SQLite, no RLS) is out. Workers differ from Node in ways
that touch the API: no native addons, no filesystem, no `worker_threads` or `child_process`, no
I/O object shared between requests, no dynamic WebAssembly compilation, and CPU limits per
request (10 ms on Free; up to 5 minutes, default 30 s, on Paid).

## Decision

1. **A thin adapter, not a fork.** `apps/hosting-cloudflare` wires the existing API ports to
   Workers; business rules stay in `apps/api`, as the Vercel adapter did before ADR 0029 retired it.
2. **PostgreSQL through Hyperdrive.** Each `fetch` and `scheduled` call binds its own
   connection (postgres.js, `max: 5`, `prepare: true`) through a request-scoped SQL client and
   closes it only after the response body and deferred work finish. The binding socket is
   internal, so the client uses no TLS; Hyperdrive owns TLS to the origin. Hyperdrive's query cache
   stays disabled: it caches reads outside transactions, which here are the global accounts,
   sessions, grants and API keys, so a revoked session could stay valid until the entry expires.
   Tenant reads run in transactions and are never cached. `deploy:worker` re-asserts it.
3. **Ports replaced at composition, never by branching business code.** `buildContainer` takes
   optional overrides that only the Worker sets:
   - `passwordHasher`: Argon2id and legacy PBKDF2 in plain JavaScript (`@noble/hashes`), same
     parameters and PHC encoding as the native hasher, with stored-cost limits checked before any
     computation. `hash-wasm` was rejected because workerd forbids `WebAssembly.compile`.
   - `documentReader`: PDF text read inline instead of in a worker thread; OCR stays off.
   - `referenceReader`: the repository references (`data/project_coordinates.json`,
     `data/canonical_entities.json`) bundled as JSON modules, with the same contracts and
     single-tenant rule as the file reader.
   - `objectStorage`: evidence files in a private R2 bucket behind SIPGES's own checks.
4. **SIPGES's own security still applies to every request.** Static Assets run Worker-first, so
   the strict CSP, security headers and host allowlist cover the SPA. The Worker refuses to start
   without `SIPGES_ALLOWED_HOSTS`; it is never derived from the client-controlled Host header.
5. **Scheduled work runs on Cron Triggers** (every 15 minutes); event automation after a write
   finishes through `waitUntil`, as the Vercel adapter did.
6. **Workers Paid is required.** Argon2id costs about 250 ms of CPU per login and a legacy hash
   about 1 s (rehashed to Argon2id on first login), far above the Free limit.

## Consequences

- One API, two runtimes (Node for development and tests, Workers in production) differing only in composition; each new port
  that touches the filesystem, threads or native code needs a Worker implementation or override.
- Verified locally only: the full Playwright suite passes against `wrangler dev` with
  PostgreSQL through Hyperdrive (93 passed, 1 optional skip; ODD L20). Not verified: a deployed
  Worker, Hyperdrive against Neon, R2 in an account, latency against the Node build.
- Migrations run in the deploy job (`migrate.mjs`), not per isolate: the first request no longer
  pays the advisory-lock and DDL round trips, and a Worker started on an unmigrated database
  answers 503 instead of migrating.
- Since ADR 0029 Workers is the only deployment target. Deploying, Cloudflare account access and
  any real-data migration still need the owner's explicit word; the steps are in
  [docs/deployment/cloudflare-workers.md](../deployment/cloudflare-workers.md).
