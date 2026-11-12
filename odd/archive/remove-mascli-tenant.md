# Remove the leftover MASCLI tenant

After the rename, the project picker lists Sechura twice: `MASCLI/PRJ-SECHURA` and `SIPGES/PRJ-SECHURA`.
Migration 0030 renamed every MASCLI tenant; the old Worker, still serving between `migrate` and
`deploy`, re-created its default `MASCLI/PRJ-SECHURA` through `tenancy.bootstrap()` and granted it
to the administrators. Remove it, moving any data to the SIPGES tenant.

## Specs

- S1 — «hey bro al momento de loguarme me aparece seleccione un proyecto , porque me sale 2 veces el proyecto sechura ? el que dice mascli debe eliminarse y si tenia datos pasarse al nuevo sipges»
- S2 — After the change, no `MASCLI/*` tenant and no grant to one remains; the project picker lists `SIPGES/PRJ-SECHURA` and `SIPGES/PRJ-ALGARROBO` only.
- S3 — No tenant-owned row is lost: a `MASCLI/<project>` tenant whose data cannot be moved to `SIPGES/<project>` stops the migration (error, transaction rolled back) instead of deleting anything.
- S4 — «te autorizo todo y haslo tu», in reply to renaming the stored display name "Administración MASCLI Workers" (`users.full_name` of the administrator created on the empty database; no API edits it). After the change the account reads `Administración SIPGES`; only an exact match is renamed.

## Tasks

- T1 — S1–S4: migration `0031_remove_mascli_tenant.sql` plus a PostgreSQL test in the style of `apps/api/test/platform/rename-sipges-migration.test.ts`. Route: delegated worker (context backstop). Commit: `04fd27a` (migration), `ad02701` (deploy log); PR #119 merged as `265c7a9`.
- T2 — S2: after deploy, the picker in production shows each project once. Route: inline, owner's browser. Done: deploy run applied `0031_remove_mascli_tenant`; `GET /system/auth/scopes` returns only `SIPGES/PRJ-ALGARROBO` and `SIPGES/PRJ-SECHURA`; `GET /system/auth/me` full_name `Administración SIPGES`; `/health` 200. Commit: n/a.

## Log

- L1 — S1 verbatim above.
- L2 — Evidence 2026-11-01: `GET /system/auth/scopes` returned `MASCLI/PRJ-SECHURA`, `SIPGES/PRJ-ALGARROBO`, `SIPGES/PRJ-SECHURA`. `GET /system/export` with scope `MASCLI/PRJ-SECHURA`: all 14 collections empty. `tenancy.bootstrap()` (apps/api/src/contexts/tenancy/application/tenancy-service.ts) ensures `DEFAULT_SCOPE` and grants every admin; the deploy runs `migrate` before `wrangler deploy` (.github/workflows/deploy-workers.yml), so the old version could run it after 0030.
- L3 — T1 evidence 2026-11-01 (S1–S4). RED: with `0031` absent, `apps/api/test/platform/remove-mascli-tenant-migration.test.ts` failed 8/8 on assertions (`expected [] to deeply equal ['0031_remove_mascli_tenant']`, `promise resolved "[]" instead of rejecting`). GREEN: 8/8 pass (PGlite, same setup as `rename-sipges-migration.test.ts`): empty MASCLI tenant and grants deleted with every SIPGES row, grant, FK, trigger and RLS flag unchanged (S1, S2); data moved to `SIPGES/<project>` with child rows, grants carried over, or the tenant renamed when the SIPGES one does not exist (S1); a repeated key in `module_records` or `project_settings` raises naming the table and leaves every row of both tenants, the grants and `schema_migrations` exactly as before (S3); no MASCLI tenant is a no-op, also when the SQL runs twice; owner role without BYPASSRLS keeps the data (forced RLS lifted before counting; removing that lift makes the test fail); `GET /system/auth/scopes` service call lists `SIPGES/PRJ-ALGARROBO`, `SIPGES/PRJ-SECHURA` only; exact-match display-name rename (S4). Checks: `pnpm --filter @sipges/api test` exit 0 (107 files passed, 5 skipped; 774 tests passed, 14 skipped: PostgreSQL-gated, `SIPGES_TEST_DATABASE_URL` unset); `pnpm lint` exit 0; `pnpm typecheck` exit 0; `pnpm boundaries` exit 0. Pending: regenerate `apps/hosting-cloudflare/src/migrations.ts` (`pnpm --filter @sipges/hosting-cloudflare migrations`); its `test/migrations.test.ts` fails until then.
- L4 — Independent verify mvxgpz7q-3-gf8y: no severe finding; S1–S4 met; real PostgreSQL 18.6 probe (role like Neon's: BYPASSRLS, table owner) scenarios A–D through `pnpm … migrate`: empty tenant removed, data moved, key conflict and `project_settings` conflict exit 1 with identical before/after dumps. Advisory acted on: `migrate.mjs` now prints the server message and SQLSTATE of a PostgreSQL error (client-side causes keep only their class, so the URL is never printed); RED 4/4 then GREEN, hosting-cloudflare 18/18. Not acted on: a manually created `MASCLI/*` scope is still allowed (not requested).
- L5 — Delivered: PR #119 merged as `265c7a9`; the Workers deploy applied 0031 and production shows each project once.
