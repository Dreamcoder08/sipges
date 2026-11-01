# ADR 0029 — Retire the Vercel host: Cloudflare Workers is the only host

- Status: Accepted
- Date: 2026-11-01
- Task: `odd/tasks/retire-vercel.md` (T1–T3)
- Supersedes, for hosting only: the statements in ADRs 0006, 0014, 0016 and 0026 that describe Vercel as the current host.

## Context

SIPGES was published on Vercel (`apps/hosting`, private Blob, Neon) until
[ADR 0028](0028-cloudflare-workers-hosting.md) added a Cloudflare Workers adapter
(`apps/hosting-cloudflare`, Hyperdrive + Neon, R2). The Worker now serves
`https://sipges.dreamcoder-dev08.workers.dev`, so two hosts were kept in sync for no benefit.
The owner asked why Vercel stayed once Cloudflare was in place. The Vercel demo held only
synthetic academic data.

## Decision

1. Remove `apps/hosting` and its `@vercel/*` dependencies; Cloudflare Workers is the only host.
2. Do not migrate the Vercel demo's data. The Neon `neondb` database that backed it stays in Neon
   untouched, as a backup.
3. Keep the HTTP cron endpoint (`/system/automations/cron`) and `SIPGES_CRON_SECRET` /
   `CRON_SECRET` unchanged as a generic scheduler entry point for any external scheduler. The
   Worker itself uses a Cron Trigger.
4. Delete the Vercel project after the docs and code are merged; that step is external to the
   repository.

## Consequences

- One production runtime to operate and document; the API keeps running on Node for development
  and tests.
- Dated records (`docs/history/**`, closed ODD logs) keep describing Vercel as it was.
- The Vercel-specific rollback path (pointing the domain back) no longer exists; see
  [the Workers guide](../deployment/cloudflare-workers.md#rolling-back).
- Nothing is lost: the synthetic demo data was not needed, and the backup database is preserved.
- The Neon project `neon-aero-brush` (both `neondb` and the Workers database) was created through
  Vercel's Neon Marketplace integration and is billed via Vercel. Deleting the Vercel project did
  not touch it, but the Vercel account and its Neon integration must stay: removing either would
  take the production database with it. The private Blob store `mascli-demo-synthetic-evidence`
  (synthetic evidence) also remains, unconnected.
