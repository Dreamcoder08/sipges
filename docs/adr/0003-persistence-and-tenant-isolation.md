# 0003 — Persistence and tenant isolation

## Context
Python uses one SQLite file per tenant plus a global auth database, JSON settings files and a local upload directory. Free hosts have ephemeral disks (see `odd/archive/python-free-hosting-preparation.md`), and file-per-tenant does not scale horizontally.

## Decision
- **PostgreSQL** is the single system of record. **Drizzle ORM** for typed schema and SQL-first queries; versioned migrations committed to the repo.
- **Shared schema, `tenant_id` column on every tenant-owned table, enforced by Row-Level Security.** Each request runs in a transaction that executes `SET LOCAL app.tenant_id = $1`; RLS policies compare against `current_setting('app.tenant_id')`. The application connects with a non-owner, non-`BYPASSRLS` role. `SET LOCAL` is transaction-scoped, so it is safe with transaction-mode connection poolers.
- Defense in depth: repositories also take a `TenantContext` argument, so isolation holds even if RLS were disabled.
- Global tables (no RLS): `users`, `sessions`, `tenants`, `grants`, and three added later:
  - `api_keys` (migration 0014): looked up by key prefix before a tenant is known, so it has no RLS; each row carries `tenant_id` and the store filters every list and revoke by it. Only the SHA-256 of the secret part is stored.
  - `push_subscriptions` (0015): scoped to a person and device (`username`, FK to `users`, cascade delete), not to a tenant; a push reaches a subscription only through that person's `grants` for the project that raised it.
  - `login_failures` (0001): login throttling keyed by `subject` (`user:<name>` or `ip:<address>`); no tenant data, and rows outside the throttling window are deleted.
- Territorial records keep the generic `(tenant_id, module, record_id, payload jsonb)` model for contract parity, with **per-module Zod validation** at the boundary (correction, ADR 0008).
- Lazy Python tables become explicit migrations (`document_reviews`, `digital_alert_reviews`, `preventive_actions`, `preventive_action_log`).
- Per-tenant settings (IRSA config, indicator config) move to a `tenant_settings` table seeded from the JSON defaults.
- Tests use **PGlite** (real Postgres compiled to WASM, in-process) so RLS and SQL are exercised without Docker; Docker Postgres for end-to-end.

## Amendment (T4)
Drizzle ORM is not used. Repositories write explicit parameterized SQL through a small `SqlClient` port (`apps/api/src/platform/database/sql-client.ts`) implemented by PGlite and postgres.js, and schema changes are hand-written, versioned `.sql` migrations applied by `migrator.ts`, each in its own transaction. Reasons: RLS policies, `SET LOCAL` and grants are plain SQL anyway; one port keeps tests (PGlite) and production (postgres.js) on the same code path; no generated code to review. Drizzle can still be adopted later behind the same port if query volume justifies it.

## Amendment (2026-11-02, functional-closure T22)
The tenant is the project. A record's `Proyecto_ID` field is not a second filter: every screen and report counts all records the tenant's RLS returns, so Inicio, Panorama, the territorial map, situational, strategic, consensus and integrated analysis, management, text analysis and conflict risk count the same records. The legacy rule "an empty `Proyecto_ID` means `PRJ-SECHURA`" is gone. On write, `RecordsService.create`, `replace` and `importRows` (HTTP, MCP, ingest keys and analyst proposals) fill a missing or empty `Proyecto_ID` from the tenant. A different value is **rejected**, never overwritten: 422 on `Proyecto_ID` for a single record, and the whole import is refused with a problem on that row. Rejecting matches the tenancy middleware, which already answers 403 to a request body naming another project, and keeps a mistaken file from silently landing in the wrong project. `Proyectos` keeps `Proyecto_ID` as its own record id. Existing records are not rewritten.

## Alternatives rejected
- Schema-per-tenant: stronger isolation, but migrations scale with tenant count and `search_path` breaks under transaction poolers.
- Database-per-tenant: mirrors Python, impossible on free tiers.

## Consequences
- One migration path, horizontal scaling, consistent backups.
- RLS policies must be tested explicitly (cross-tenant read/write must return nothing/403).
- T13 maps each SQLite tenant file to a `tenant_id`.

## References
PostgreSQL Row Security Policies docs; AWS "Multi-tenant data isolation with PostgreSQL RLS"; Drizzle docs; PGlite docs.
