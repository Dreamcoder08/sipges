# 0008 — Corrections to Python behavior defects

## Context
User decision L7: fix the defects in behavior contract §8 in the TypeScript version, each documented here and covered by a test. Everything not listed keeps parity.

## Decisions (numbers match §8)
1. **IRSA bands** become half-open `[lo, next_lo)`; the top band includes 100. Values like 24.995 now map to `Verde`, not `Rojo`.
2. **Roles:** authorization uses only `admin, analista, coordinador, consulta`. `Roles`/`Usuarios` records stay as display data.
3. **Non-mutating POSTs** (`/system/analyze`, document-lab analyze/compare/report, semantic analyze) are allowed for every authenticated role; they persist nothing.
4. **`/system/auth/scopes`** goes through session and origin checks; anonymous POST returns 401.
5. **Project switch** in the UI calls `POST /select-project`; the server stays the source of truth.
6. **Project defaults:** body `project_id` defaults to the active scope, never to `PRJ-SECHURA`; multipart forms are checked too.
7. **Export** produces a tenant-scoped data dump that never contains user, session or TOTP data. User decision L32 chooses versioned JSON at the existing `GET /system/export`, downloading `mascli-tenant.json` with JSON content type instead of the legacy SQLite/octet-stream `mascli.db`. This artifact-format change is explicit; no physical PostgreSQL backup or whole-database copy is exposed.
8. **Auth hygiene:** session purge, login throttling, encrypted TOTP with replay protection (ADR 0004). Account deactivation (`POST /system/auth/accounts/:username/deactivate`) and grant revocation (`DELETE /system/auth/grants`, same target fields as POST) are added as global admin routes. Deactivation and session deletion are atomic, session issuance rechecks active status under a row lock, and serialized deactivation refuses the last active administrator to prevent bootstrap lockout. Scope-free account administration applies only to the new deactivation endpoint; existing account-route middleware ordering stays unchanged.
9. **Uploads:** content sniffing (magic numbers) in addition to extension, size limit range-checked at startup, storage write and metadata row are compensated on failure (no orphans); implemented in T8, see docs/migration/evidence.md.
10. **Generic CRUD:** per-module Zod validation (unknown extra fields still allowed for compatibility), `limit` capped at 500, DELETE of a missing record returns 404 and is not audited, record delete cascades attachment links (implemented in T8; see docs/migration/evidence.md).
11. **Open/closed states:** one shared `ClosedStates` policy used by dashboard, analysis and IRSA.
12. **Dead code** is not ported; IRSA reports the configuration file's version.
13. **No personal names** hard-coded; bootstrap display name comes from `MASCLI_ADMIN_FULL_NAME` (default `Administrator`).
14. **Timestamps** are stored as `timestamptz` and returned as UTC ISO-8601 with seconds and a `Z` suffix (`2026-10-12T12:00:00Z`). Python returned naive server-local time (`datetime.now().isoformat(timespec="seconds")`), which is ambiguous across hosts.

15. **Grant administration is global:** `/system/auth/grants` remains authenticated, origin-checked and admin-only, but its target `project_id` is not interpreted as a business-scope write. Python's generic body guard prevented admins from granting another project. Tenancy tests pin cross-project grants, rejection of non-admins and missing references.

## Consequences
- Each item is a named test in the owning context; the parity suite marks these as intentional differences.
