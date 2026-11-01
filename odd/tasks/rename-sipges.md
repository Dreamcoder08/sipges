# Rename MASCLI to SIPGES

Replace every name and reference to MASCLI with the new product name, at once and without
backwards compatibility, as the owner chose.

## Specs

- S1 — «elimina todo el nombre o relacion con MASCLI este es su nuevo nombre , Sistema Inteligente de Predicción y GEStión Social-SIPGES»
- S2 — Chosen scope, verbatim: «Todo de una vez» — «Reemplazo total incluido datos y variables, sin compatibilidad. Requiere reconfigurar Worker y Vercel y cierra todas las sesiones.»

## Naming (applied everywhere)

| Before | After |
| --- | --- |
| MASCLI, MASCLI 4.0 (product) | SIPGES (Sistema Inteligente de Predicción y GEStión Social) |
| `@mascli/*` packages | `@sipges/*` |
| `MASCLI_*` environment variables | `SIPGES_*` |
| `X-MASCLI-Scope` and other `X-MASCLI-*` headers | `X-SIPGES-*` |
| cookie and storage keys containing `mascli` | same key with `sipges` |
| tenant company id `MASCLI` (scopes `MASCLI/<project>`) | `SIPGES` |
| stored values `MASCLI 4.0` (alert origin, audit module) | `SIPGES` |
| Worker `mascli`, R2 bucket `mascli-evidence`, Hyperdrive `mascli` | `sipges`, `sipges-evidence`, `sipges` |

## Exceptions (history, not product)

- `reference/python/**` (the legacy prototype that was named MASCLI; it is the behavioural reference).
- `odd/archive/**`, `odd/evidence/**`, `.engram/**`, already-closed ODD logs: they record what happened.
- Absolute local paths (`…/PROYECTOS/mascli/…`) and the GitHub repository URL until the repository itself is renamed.

## Tasks

- T1 [x] S1,S2 — Code, packages, configuration, UI, docs, tests (one mechanical commit + reviewed fix-ups); route: worker after the in-flight PRs land; commit: `752184e`
- T2 [x] S2 — Database migration: company id and stored `MASCLI 4.0` values, with RLS-safe rename and test; route: worker, test first; commit: `9620ab9` (risk item 1)
- T3 [x] S2 — Workers deployment: new Worker `sipges`, secrets `SIPGES_*`, R2 bucket copy, Hyperdrive rename, Google OAuth redirect URI; route: inline; commit: `f19cf74` (deployed 61e9faa9)
- T4 [x] S2 — Vercel: environment variables renamed (needs the owner's Vercel access); route: owner + inline; done in place, production `f19cf74` READY
- T5 [ ] S1 — Repository rename on GitHub (redirects keep old links) and local remote update; route: owner word
- T6 [x] S1,S2 — Independent verification (tenant isolation after the data migration, sessions, sign-in); route: gentle-ai-verify

## Risk

Items 1 (stored data rewritten), 2 (cookies, MFA and Google sign-in config), 3 (env and header contracts), 5 (deployment).

## Log

- L1 — «elimina todo el nombre o relacion con MASCLI este es su nuevo nombre , Sistema Inteligente de Predicción y GEStión Social-SIPGES»; scope question answered «Todo de una vez».
- L2 — Size on origin/main: 576 files, 3,309 occurrences; most frequent: `@mascli/contracts`, `MASCLI_COOKIE_SECURE`, `X-MASCLI-Scope`, `MASCLI/PRJ-SECHURA`, `MASCLI_TENANT`, `MASCLI_DATA_KEY`. Open PRs touching the same files (docs cleanup, human-validation wording) land first to avoid a 576-file conflict.
- L3 — Owner authorized merging the docs and wording PRs first («yes te autorizo todo y avanza»); #97, #98 and #99 landed, then the branch was rebased on main (c9cddd2, with the Workers auto-deploy).
- L4 — T3 prepared before merging (nothing touched the running `mascli` Worker): Worker `sipges` secrets `SIPGES_*`, GitHub secret `SIPGES_MIGRATION_DATABASE_URL`, R2 bucket `sipges-evidence` with all 51 objects copied (sizes identical), Google OAuth redirect URI for the new host added and consent screen renamed SIPGES.
- L5 — T1 `752184e` (mechanical rename) and T2 `9620ab9` (migration 0030 + tests). First full run: 3 API failures (`permission denied for table record_links`): the role move revoked table privileges before copying column grants, and REVOKE ALL drops column grants. Fixed by copying column grants first; the migration test now asserts `UPDATE (evidence_source_id)` on record_links for sipges_tenant (RED with the old order, GREEN after). Gates: lint, typecheck, API 761 passed / 14 skipped, web, hosting-cloudflare 9/9, tooling, `wrangler deploy --dry-run`. Remaining `mascli` hits are history (closed ODD tasks, ADR titles 0020/0027, applied migrations 0001–0029, CHANGELOG, diagrams snapshot) and the repository/Vercel URLs pending T4/T5.
- L6 — Independent verifier (mvxaepb2-1-1lbo): grants 38/38 identical, 25 tenant tables rewritten, FKs and forced RLS preserved, re-run is a no-op, only exact `MASCLI 4.0` values renamed; FAIL on policies: `operator_read_evidence_history` kept the literal `mascli_tenant`, so it stopped rejecting the runtime role (not exploitable: no SELECT grant). Fixed in `45aaf24` (policy recreated naming `sipges_tenant`; test asserts no policy names mascli; RED then GREEN). Gates: lint, API 761 passed / 14 skipped. Unproven until production: the GRANT/DROP ROLE statements as the Neon login role (CREATEROLE, not superuser; PGlite test with a NOSUPERUSER CREATEROLE owner passes). Native review `review-e824ac94f56e219e` is created but blocked: the restarted Pi session has no reviewer model snapshot until the owner reselects the profile.
- L7 — Native review `review-fb92727177435f06` (risk + reliability, base 752184e) approved and acknowledged after the owner reselected the profile; advisories only (policy recreation copies command and roles but not every attribute; history fixture could assert rows). PR #109 merged main (#105, #108) with mechanical conflicts (hono, lockfile, one new test using `MASCLI_*`); local gates 7/7 and CI 9/9 green; merged as `f19cf74`.
- L8 — Cutover. Vercel: 12 production variables renamed in place to `SIPGES_*` through the dashboard API (values kept); the Sensitive `MASCLI_VAPID_PRIVATE_KEY` cannot be renamed or read, so a new VAPID pair was generated in the browser and stored directly (existing Vercel push subscriptions must re-subscribe); old key deleted. Branch-scoped preview variables of deleted branches cannot be edited and were left. Workers: CI then `deploy-workers.yml` applied `0030_rename_to_sipges` as the Neon login role (only NOTICEs; membership of `mascli_workers` in `sipges_tenant` confirmed, `mascli_tenant` gone), deployed `sipges` 61e9faa9, smoke `/health` → `SIPGES`. Independent live verification (mvxc5mxa-2-s8vb) PASS: admin password + TOTP login, scopes exactly `SIPGES/PRJ-ALGARROBO` and `SIPGES/PRJ-SECHURA`, review queues unchanged (1144/208/126 and 1004/182/107), evidence download 200, no tenant id starting with `MASCLI` in 29 tenant tables; 55 sources and 51 uploads (the earlier 53/50 note was approximate; no tenant lost rows). R2 re-copied 51/51 with no size mismatch; old Worker `mascli` deleted (old host 404). Pending: T5 repository rename; the old R2 bucket `mascli-evidence` and the old OAuth redirect URI are kept until the owner retires them.
