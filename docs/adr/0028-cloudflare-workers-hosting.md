# ADR 0028 — Cloudflare Workers as an optional host, through Hyperdrive to PostgreSQL

- Status: Accepted (adapter verified locally; not deployed)
- Date: 2026-10-31
- Task: `odd/tasks/cloudflare-workers.md` (T1–T5)

## Context

MASCLI runs its Hono API and React SPA on Node, published on Vercel. The owner asked why not
Cloudflare and chose «Cloudflare Workers + Hyperdrive + Neon». The data must stay in PostgreSQL
with forced row-level security, so D1 (SQLite, no RLS) is out. Workers differ from Node in ways
that touch the API: no native addons, no filesystem, no `worker_threads` or `child_process`, no
I/O object shared between requests, no dynamic WebAssembly compilation, and CPU limits per
request (10 ms on Free; up to 5 minutes, default 30 s, on Paid).

## Decision

1. **A thin adapter, not a fork.** `apps/hosting-cloudflare` wires the existing API ports to
   Workers; business rules stay in `apps/api`, exactly as `apps/hosting` does for Vercel.
2. **PostgreSQL through Hyperdrive.** Each `fetch` and `scheduled` call binds its own
   connection (postgres.js, `max: 5`, `prepare: true`) through a request-scoped SQL client and
   closes it only after the response body and deferred work finish. The binding socket is
   internal, so the client uses no TLS; Hyperdrive owns TLS to the origin.
3. **Ports replaced at composition, never by branching business code.** `buildContainer` takes
   optional overrides that only the Worker sets:
   - `passwordHasher`: Argon2id and legacy PBKDF2 in plain JavaScript (`@noble/hashes`), same
     parameters and PHC encoding as the native hasher, with stored-cost limits checked before any
     computation. `hash-wasm` was rejected because workerd forbids `WebAssembly.compile`.
   - `documentReader`: PDF text read inline instead of in a worker thread; OCR stays off.
   - `referenceReader`: the repository references (`data/project_coordinates.json`,
     `data/canonical_entities.json`) bundled as JSON modules, with the same contracts and
     single-tenant rule as the file reader.
   - `objectStorage`: evidence files in a private R2 bucket behind MASCLI's own checks.
4. **MASCLI's own security still applies to every request.** Static Assets run Worker-first, so
   the strict CSP, security headers and host allowlist cover the SPA. The Worker refuses to start
   without `MASCLI_ALLOWED_HOSTS`; it is never derived from the client-controlled Host header.
5. **Scheduled work runs on Cron Triggers** (every 15 minutes); event automation after a write
   finishes through `waitUntil`, as it already does on Vercel.
6. **Workers Paid is required.** Argon2id costs about 250 ms of CPU per login and a legacy hash
   about 1 s (rehashed to Argon2id on first login), far above the Free limit.

## Consequences

- One API, three runtimes (Node, Vercel, Workers) differing only in composition; each new port
  that touches the filesystem, threads or native code needs a Worker implementation or override.
- Verified locally only: the full Playwright suite passes against `wrangler dev` with
  PostgreSQL through Hyperdrive (93 passed, 1 optional skip; ODD L20). Not verified: a deployed
  Worker, Hyperdrive against Neon, R2 in an account, latency against the Node build.
- No deployment, Cloudflare account access or switch of the published demo happens without the
  owner's explicit word. The steps are in
  [docs/deployment/cloudflare-workers.md](../deployment/cloudflare-workers.md).
