# Functional closure (end to end)

Make SIPGES functional and ready for handover across every area, from three read-only audits run on main
`fc976c7` (2026-11-01). Delivery: one small PR per task, merged by hand only with the 8 CI checks green (the repo
is private on GitHub Free, so `main` does not enforce them). Local gate: `pnpm verify:fast`.

## Specs

- S1 — «el objetivo es que el proyecto sea funcional , desde la arquitectura , backend persistencia , interfaz , gestion , registros , irsa , inteligencia , geografia , infarestructura y despligue , calidad , pruebas ,privacidad ,documentacion y cierre»
- S2 — «eso despues»: the owner deferred the cousin's GitHub access, the account handover and GitHub Pro; they are out of scope until asked.
- S3 — First load in production must stop waiting on the database: static files are served without the backend setup (audit: `run_worker_first: true` sends `/assets/*` through migrations check and container build).
- S4 — A failed deploy must not stay live, and the health check must prove the database answers.
- S5 — CI must spend fewer of the 2,000 monthly minutes without dropping any check on code changes.
- S6 — After sign-in the person lands on Inicio; Inicio's links and notes say what really happens.
- S7 — Docs, ADRs and ODD documents must match the code and the Workers-only hosting; a handover guide lists accesses, secret rotation, incident steps, backup and restore.
- S8 — Privacy: close ai-egress-privacy T1/T2 in its document and check in production that external AI egress is off (T3); automation channel sends are audited.
- S9 — Product flows still open: notifications inside Bandeja, Configuración by sections, Administración can reset a user's MFA, cited answers in Inicio (T7b), Registros «Todos» in one request.
- S10 — Architecture: contexts stop writing other contexts' tables (ADR 0002) and the duplicated `module_records` readers become one port; semantic intelligence reports when no embedder is reachable.
- S11 — Tests: mobile coverage of hub tabs, record pages and open sheets at 360 and 412 px; the e2e start-up timeout no longer equals the test timeout.

## Tasks

- T1 [ ] — S3, S4: Worker serves static assets without backend setup; `/health/ready` with `SELECT 1`; deploy rolls back when the smoke test fails. Risk: item 5 (delivery). Route: delegated (Herdr tab, own verifier). Commit: pending.
- T2 [x] — S5, S11 (timeout): CI paths filter for docs-only changes, Python parity only when `reference/python/**` changes, monthly Dependabot, e2e start-up timeout. Risk: item 5. Route: inline. Commit: PR #137.
- T3 [x] — S6: land on `/inicio`, IRSA card to `/analisis`, honest composer note, remove dead `PendingScreen`, distinct screen icons, CHANGELOG line about the bottom bar. Route: delegated (Herdr tab). Commit: PR #151.
- T4 [x] — S7, S8 (bookkeeping): reconcile ODD documents with git, Workers-only deployment docs, README Node version, ADR 0003 global tables, handover and backup/restore guide. Route: delegated (Herdr tab). Done: `28e62b7`, PR #138 (L4).
- T5 [ ] — S8: production check of the external-AI switch and egress refusal (needs the owner's sign-in). Route: inline with the browser. Commit: n/a.
- T6 [ ] — S9: notifications as «Avisos» in Bandeja, bell removed. Route: wave 2. Commit: pending.
- T7 [ ] — S9: Configuración with section navigation (no API change). Route: wave 2. Commit: pending.
- T8 [ ] — S9: «Restablecer MFA» in Administración. Risk: item 2 (identity). Route: wave 2, own verifier. Commit: pending.
- T9 [ ] — S9: `GET /api/registros/summary` and Registros «Todos» on it. Route: wave 2. Commit: pending.
- T10 [ ] — S10: command ports for `module_records`, `automation_cursors` and `audit` writes; one records reader port. Route: wave 3. Commit: pending.
- T11 [ ] — S10: embedder availability in config and UI. Route: wave 3. Commit: pending.
- T12 [ ] — S8: audit row per automation channel send. Risk: item 2 (data exposure). Route: wave 3, own verifier. Commit: pending.
- T13 [ ] — S11: mobile coverage of hub tabs, `/objeto`, open sheets at 360/412 px. Route: wave 3. Commit: pending.
- T14 [ ] — S9: cited answers in Inicio through the egress guard (workspace-architecture T7b). Route: after T5. Commit: pending.

- T15 [ ] — S10: `postgres` 4.0 (Dependabot #148): driver rewrite with server-typed parameters, `sql.array()` removed, stricter transactions and a new `workerd` export on Cloudflare Workers. Exposure measured: one adapter (`apps/api/src/platform/database/postgres.ts`), one `begin`, all date columns `timestamptz`. Check on a Neon branch through Hyperdrive before production. Risk: items 1 and 5. Route: own verifier. Commit: pending.
- T16 [ ] — S10: `unpdf` 2.0 (Dependabot #147) fails CI; adapt the document extraction or pin 1.x with a reason. Route: wave 3. Commit: pending.
- T17 [ ] — S7: `SIPGES_DATA_KEY` rotation tool and procedure (ADR 0004 says one exists; none does). Risk: item 1 (rewrites encrypted data). Route: own verifier. Commit: pending.
- T18 [ ] — S7: R2 evidence backup (no backup configured) and a drilled Neon + R2 restore. Risk: item 5. Route: needs the owner's Cloudflare access. Commit: pending.

Outside the code (owner or external service): GEOCATMIN live check while its services time out (territorial-intelligence-alerts T1/T2), push on a real phone and credentialed channels (T8 there), data-quality T6 with original sources, a Neon restore drill, and where an embedder runs in production.

## Log

- L1 — S1 verbatim, 2026-11-01. S2 verbatim, same day.
- L2 — Audits (three read-only explorers on `fc976c7`): no stubbed routes, 501s or TODOs; every web call has an API route; all tenant tables force RLS. Gaps found: Worker-first static serving (likely first-load cause), no deploy rollback, static `/health`, CI without paths filter (web built 4× per run), missing backup drill and handover docs, docs describing Node/systemd hosting, login landing on the old Dashboard, Bandeja without notifications, flat Configuración, no MFA reset in the UI, cross-context table writes, duplicated record readers, unreachable default embedder on Workers, automation channels outside the egress audit, thin mobile coverage.
- L3 — ai-egress-privacy: Engram #13362 records PR #130 merged and deployed with the 3 verifier blockers fixed; its document stops at L5, so T4 closes T1/T2 there and T5 runs T3.
- L4 — T4 done (S7, S8 bookkeeping), `28e62b7` on `chore/fc-docs-closure`, PR #138. ai-egress-privacy T1/T2 closed (L6, L7) citing PR #130 `b7e5aab`, T3 open; «Commit: pending» reconciled with git in rename-admin-username (T1), compact-sidebar (T1, T3; T4 open) and workspace-architecture (T1–T4, T6, T7a; T5 and T7b open). readiness.md Node/systemd/cloudflared/journald sections marked historical; README Node ≥22 and plain pnpm (CI: `node-version: 22`, `pnpm/action-setup`, no Corepack); ADR 0003 lists `api_keys`, `push_subscriptions`, `login_failures`; stale Hyperdrive placeholder step removed; new `docs/operations/handover.md` (restore: not yet drilled). Checks: `prettier --check` exit 0 (Markdown is in `.prettierignore`, so trivially), relative links resolve, `pnpm odd:status` exit 0. Found: no `SIPGES_DATA_KEY` rotation tool despite ADR 0004; `odd:status` ignores tasks written as `- T1 — …` without a checkbox; no R2 backup in the repo.
- L5 — T2 done inline: PR #137 merged with 8/8 checks (paths filter, Python parity only on `reference/python/**` or `ci.yml`, monthly Dependabot, 120 s budget for `02-cookie-policy`). Gentle AI review approved; follow-ups kept: shallow fetch of the base instead of `fetch-depth: 0`, one source for the duplicated ignore list. Python tests only read inside `reference/python` (`conftest.py:49`, `app.py:20`), so the filter cannot skip them silently.
- L6 — T3 done by its tab: PR #151 merged (land on `/inicio`, IRSA card to `/analisis`, honest composer note, distinct icons, dead `PendingScreen` removed); RED 8 unit tests, GREEN web 434/434. Owner authorized agent tabs to commit and push without a prompt (`git commit`/`git push` removed from `permissions.ask`; force push, rebase and hard reset still ask).
- L7 — Dependency queue: merged #139, #141, #142, #143 (8/8), #145 (react group, the fix from #144 working), #146; #140 closed (react-dom alone breaks React). Held: #148 `postgres` 4.0 (T15) and #147 `unpdf` 2.0 failing (T16). New tasks T17 (data key rotation) and T18 (R2 backup and restore drill) come from T4's handover findings.
