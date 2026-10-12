# 0003 — Persistence and tenant isolation

## Context
Python uses one SQLite file per tenant plus a global auth database, JSON settings files and a local upload directory. Free hosts have ephemeral disks (see `odd/tasks/python-free-hosting-preparation.md`), and file-per-tenant does not scale horizontally.

## Decision
- **PostgreSQL** is the single system of record. **Drizzle ORM** for typed schema and SQL-first queries; versioned migrations committed to the repo.
- **Shared schema, `tenant_id` column on every tenant-owned table, enforced by Row-Level Security.** Each request runs in a transaction that executes `SET LOCAL app.tenant_id = $1`; RLS policies compare against `current_setting('app.tenant_id')`. The application connects with a non-owner, non-`BYPASSRLS` role. `SET LOCAL` is transaction-scoped, so it is safe with transaction-mode connection poolers.
- Defense in depth: repositories also take a `TenantContext` argument, so isolation holds even if RLS were disabled.
- Global tables (no RLS): `users`, `sessions`, `tenants`, `grants`.
- Territorial records keep the generic `(tenant_id, module, record_id, payload jsonb)` model for contract parity, with **per-module Zod validation** at the boundary (correction, ADR 0008).
- Lazy Python tables become explicit migrations (`document_reviews`, `digital_alert_reviews`, `preventive_actions`, `preventive_action_log`).
- Per-tenant settings (IRSA config, indicator config) move to a `tenant_settings` table seeded from the JSON defaults.
- Tests use **PGlite** (real Postgres compiled to WASM, in-process) so RLS and SQL are exercised without Docker; Docker Postgres for end-to-end.

## Alternatives rejected
- Schema-per-tenant: stronger isolation, but migrations scale with tenant count and `search_path` breaks under transaction poolers.
- Database-per-tenant: mirrors Python, impossible on free tiers.

## Consequences
- One migration path, horizontal scaling, consistent backups.
- RLS policies must be tested explicitly (cross-tenant read/write must return nothing/403).
- T13 maps each SQLite tenant file to a `tenant_id`.

## References
PostgreSQL Row Security Policies docs; AWS "Multi-tenant data isolation with PostgreSQL RLS"; Drizzle docs; PGlite docs.
