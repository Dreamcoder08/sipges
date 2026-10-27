# Cloudflare Workers + Hyperdrive + Neon hosting

Run the existing Hono API and React SPA on Cloudflare Workers, reaching the same Neon PostgreSQL
through Hyperdrive. Branch `feat/cloudflare-workers`, stacked on `feat/mascli-4-only` (PR #81).
The Vercel demo keeps running unchanged until the owner decides to switch.

## Specs

- S1 — «hey bro y porque vercel y no cloudfare ??»
- S2 — «seguro ? cuestiona con informacion actual de esta semana de la web yo quiero lo mejor de lo mejor»
- S3 — Chosen option, verbatim: «Cloudflare Workers + Hyperdrive + Neon»

## Engineering constraints (from current documentation and code, not new product requirements)

Sources checked 2026-10-27: Cloudflare Workers limits and pricing (updated 2026-10-02/12),
Hyperdrive docs (2026-10-21), Workers `node:crypto` (2026-10-17), Vercel Terms (2026-10-19).

- Keep PostgreSQL and its forced row-level security. D1 (SQLite, no RLS) is out of scope.
- Workers Paid is required (USD 5/month minimum): Free allows 10 ms CPU per request; Paid allows
  up to 5 min (default 30 s) with 128 MB memory per isolate.
- No I/O object may be shared across requests: the SQL client is created per request; the
  Hyperdrive pool keeps connections warm.
- postgres.js must use `prepare: true` through Hyperdrive (Cloudflare warns that `prepare: false`
  can hang or fail intermittently). Transaction-scoped `set_config(..., true)` and
  `SET LOCAL ROLE` stay inside one transaction, compatible with transaction pooling.
- `@node-rs/argon2` is a native addon and `node:crypto` has no argon2 in Workers: password
  hashing needs a WebAssembly Argon2id that verifies every existing `$argon2id$` hash and keeps
  the OWASP parameters (m=19 MiB, t=2, p=1).
- Legacy `pbkdf2_sha256$310000$…` hashes (reference/python/app.py:164) exceed the WebCrypto
  100,000-iteration limit on Workers; they must still verify (WebAssembly PBKDF2) or the adapter
  must refuse them explicitly — never silently fail a valid password.
- No `worker_threads`, `child_process` or filesystem at runtime: PDF text reading runs inline,
  OCR stays off (`MASCLI_OCR` unset, as on Vercel today), migrations are bundled, the SPA is
  served as Workers Static Assets, evidence files go to private R2 behind MASCLI's own checks.
- Scheduled work (automation, media polling, daily cron) moves to Cron Triggers.
- Business rules stay in `apps/api`; the adapter only wires ports, as `apps/hosting` does.
- No deployment, Cloudflare account access or credential use without the owner's explicit word;
  local verification uses `wrangler dev` (workerd) and a throwaway local PostgreSQL.

## Tasks

- T1 [ ] S3 — Viability spike: bundle the API for workerd and list every import-time and runtime blocker with evidence; route: inline; commit: pending
- T2 [ ] S3 — API seams: injectable password hasher (WASM Argon2id + PBKDF2 legacy verify), inline PDF reader, bundled migrations, request-scoped SQL client; tests first; route: inline/worker; commit: pending (identity: own commit)
- T3 [ ] S3 — `apps/hosting-cloudflare`: Worker entry, Static Assets, Hyperdrive, private R2 storage, Cron Triggers, security headers and host allowlist; route: worker; commit: pending
- T4 [ ] S2,S3 — Local verification: unit/HTTP tests, E2E against `wrangler dev` with local PostgreSQL, latency comparison with the Node build; independent verifier (identity, tenancy); route: serial checks + verifier; commit: with evidence
- T5 [ ] S1,S3 — Delivery: ADR, deployment guide, draft PR; deploy only with the owner's word and their Cloudflare account; route: inline; commit: final

## Risk

Item 2 (security): password hashing and verification move to a new implementation; tenant
isolation must survive a new SQL client lifecycle. Item 5 (delivery): new runtime, new build
and new dependencies (Wrangler, a WASM hash library) pinned under `minimumReleaseAge`.

## Log

- L1 — Conversation verbatim: «hey bro y porque vercel y no cloudfare ??»; after the first answer: «seguro ? cuestiona con informacion actual de esta semana de la web yo quiero lo mejor de lo mejor»; after the web-checked comparison: «Cloudflare Workers + Hyperdrive + Neon».
- L2 — Parent corrected its earlier claim: Workers now enables Node.js compatibility by default (compatibility date ≥ 2026-08-04) and Hyperdrive supports `pg`/postgres.js on Free and Paid. Confirmed D1 is SQLite without RLS. New: Vercel Hobby is non-commercial only; a client deployment needs Pro or another host.
- L3 — Code findings before any edit: `@node-rs/argon2` (native) in identity/infrastructure/password-hasher.ts; `node:worker_threads` in documents/infrastructure/pdf-worker-pool.ts; `node:child_process` in documents/infrastructure/ocr.ts (OCR optional, off unless `MASCLI_OCR=ocrmypdf`); `node:fs` in database/migrator.ts, database/open.ts, http/spa.ts; postgres.js `prepare: false` in database/postgres.ts:25; one long-lived SQL client per process in the Vercel adapter. Engram tools are unavailable in this session, so this document has no memory mirror.
