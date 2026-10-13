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
7. **Export** produces a tenant-scoped data dump that never contains user, session or TOTP data.
8. **Auth hygiene:** session purge, login throttling, encrypted TOTP with replay protection (ADR 0004). Account deactivation and grant revocation endpoints are added as new admin routes.
9. **Uploads:** content sniffing (magic numbers) in addition to extension, size limit range-checked at startup, storage write and metadata row are compensated on failure (no orphans).
10. **Generic CRUD:** per-module Zod validation (unknown extra fields still allowed for compatibility), `limit` capped at 500, DELETE of a missing record returns 404 and is not audited, record delete cascades attachment links.
11. **Open/closed states:** one shared `ClosedStates` policy used by dashboard, analysis and IRSA.
12. **Dead code** is not ported; IRSA reports the configuration file's version.
13. **No personal names** hard-coded; bootstrap display name comes from `MASCLI_ADMIN_FULL_NAME` (default `Administrator`).

## Consequences
- Each item is a named test in the owning context; the parity suite marks these as intentional differences.
