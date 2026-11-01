# SIPGES as the only behaviour

Retire the per-project 3.0/4.0 switch (ADR 0020 §1) so every project runs SIPGES.
Supersedes S10 of [mascli-4-situations](mascli-4-situations.md). Branch `feat/mascli-4-only`,
stacked on `feat/production-candidate-dashboard` (`f512d8d`).

## Specs

- S1 — «te autorizo todo y avanza de forma autonoma , se supone que ahora todo debe decir MASCLI 4.0 , verdad ??»
- S2 — «quiero que todo este en 4.0 , objetivo actualizar todo , eliminar redundancia objetivo estar en la vanguardia»
- S3 — Replaces mascli-4-situations S10 («lo que funciona en MASCLI 3.0 se mantiene. Las mejoras forman MASCLI 4.0, activable por proyecto y desactivada por defecto»): every project behaves as SIPGES; the switch and the 3.0-only branches are removed (S2).

## Interpretation of S2 (engineering consequences, not new product requirements)

- 4.0 rules become unconditional: closing a plan as `Completada` requires an attached evidence
  file (`evidence_required`); a high-priority (`Alta`) alert needs a second person; IRSA uses
  saved phase weights for the current phase; colour labels always show their meaning; the
  media monitor fetches only feeds a project configured and did not pause.
- Stored data is not rewritten: the `version4` key left in `project_settings.settings` is
  ignored, the `evidence_url` column and its legacy import stay (old URLs remain readable),
  and the stored value `Origen = 'MASCLI 4.0'` and audit module `'MASCLI 4.0'` stay as data.
  No migration is needed.
- Per-project configuration that is not the switch stays: colour meanings, thresholds,
  recommendation catalogue, phase and phase weights, RSS feeds.
- Visible branding names the product SIPGES. The `/system/v4/settings` path stays (no
  extra route churn); its contract drops `version4`.
- Deployment, production activation and real data still need the owner's separate word.

## Tasks

- T1 [x] S2,S3 — ADR 0027 superseding ADR 0020 §1; update ADR index, mascli-4-situations S10/T8 and media-monitoring S5 with verbatim log entries; route: inline docs; commit: pending
- T2 [x] S2,S3 — API + contracts: switch removed from settings, ports, compose and routes; 4.0 rules unconditional; API tests updated; route: worker (cancelled mid-run) + parent readback; commit: same as T3 (contracts and web compile together)
- T3 [x] S1,S2,S3 — Web + E2E: 3.0 branches and toggle removed; SIPGES in title, document title, sidebar brand and login heading; web and E2E tests updated; route: worker + parent branding edits; commit: with T2
- T4 [x] S2 — Verified: types/lint/boundaries 0, API 694/14 skipped, web 282, E2E 93 passed/1 skipped, independent static review; no HTTP differential against `f512d8d` (the contract change is intended, covered by tests); route: serial checks + verifier; commit: with T2/T3
- T5 [x] S1,S2 — Closed: evidence index, ODD log, draft PR #81 stacked on #80; route: inline; commit: `eb51a10`, follow-up `acc9783`

## Risk

Item 3 (contract): plan closing without a file now fails with `evidence_required`; GET/PUT
settings drop `version4` (a PUT that still sends it is accepted and ignored); the raw tenant
export keeps stored rows as they are. Item 2 (guards): the
two-person rule becomes universal. Outbound RSS now depends only on configured feeds.
No database migration and no stored-record rewrite.

## Log

- L1 — Original request verbatim: «te autorizo todo y avanza de forma autonoma , se supone que ahora todo debe decir MASCLI 4.0 , verdad ??». Clarification asked with four options (keep opt-in, enable demo project, default for new projects, rebrand only); answer verbatim: «quiero que todo este en 4.0 , objetivo actualizar todo , eliminar redundancia objetivo estar en la vanguardia».
- L2 — Read-only map (explore mvq4armt-3-7p62), parent spot-checked `settings.ts:35-139`, `actions.ts:117-119`, `compose.ts:380,393,463` and migration 0025 (settings are `jsonb`; the switch lives only in code defaults). 31 TypeScript files reference the switch. The two open questions of the map (URL-only closing; RSS for every tenant) are resolved by S2 «todo este en 4.0»: file required, RSS limited to configured, unpaused feeds.
- L3 — CI for PRs #79/#80 did not start: GitHub reports failed account payments or spending limit. Not a code defect; owner action in Billing & plans. Engram tools are unavailable in this session, so this document has no memory mirror.
- L4 — Worker mvq4ez8w-4-5csz was cancelled by a tool abort after editing 40 files (+325/−520). Its RED evidence was not returned, so test-first order is unproven for this unit; the parent reviewed the diff instead. Parent added the sidebar brand and login heading («Ingresar a MASCLI 4.0») and the matching E2E selectors.
- L5 — Parent checks: `pnpm typecheck` 0, `pnpm lint` 0, boundaries 737 modules / 2,173 dependencies. Full API (`--no-fs-module-cache`): 99 files passed, 5 skipped; 694 passed, 14 skipped (base 696: the removed tests asserted only 3.0 or toggle behaviour). A first focused run executed 1 of 8 files because of a harness quoting bug; superseded by the full run. The first web run exited 0 but its log was deleted by a parent cleanup command launched in parallel; rerun recorded separately.
- L6 — Independent static review mvq63n7z-5-5vaj: no severe issue; two-person rule unconditional and not bypassable, PUT with `version4` accepted and ignored, stored key neither returned nor re-saved, no migration, `evidence_url`/`Origen`/audit label kept, polling limited to enabled due feeds. Applied its suggestions: two stale comments and an ADR note that the raw tenant export keeps stored rows. Flagged to the owner: the `/version-4` menu item is now «Configuración».
- L7 — Parent confinement slip: one typecheck command wrote and removed `/tmp/null-tc` (outside the repository). Not repeated.
- L8 — First full E2E: 89 passed, 4 failed. Workflow journeys (desktop, phone) still closed plans without a file (3.0 flow); fixed in the shared journey, which now asserts the refusal and closes with an uploaded synthetic receipt. Heatmap phone and mobile viewport failed on a real overflow (475 px in a 390 px page) from `nowrap` level labels that now carry meaning; fixed separately in `3bd65d5`. Two intermediate workflow reruns failed on harness mistakes (receipt linked to an intelligence-alert id → 404; `id` read instead of `attachment.id`), retained in evidence. Final `pnpm lint && pnpm e2e`: exit 0, 93 passed, 1 skipped.
- L9 — Git hygiene: `5c8a955` ignores raw run output under `odd/evidence` (none was tracked), so status is clean apart from the owner's `.pi/`. Commit order: `5c8a955` chore, `3bd65d5` fix (valid on its own), then the `feat!` unit (API, contracts, web and E2E compile only together) with a `BREAKING CHANGE` footer.
- L10 — Native review: the whole branch (`b2ad4f9`→HEAD) exceeded the reviewer context budget (`lens_context_budget_exceeded`), so slices were assessed apart. This unit (`f512d8d`→`934fbb9`, lenses risk + reliability, tier high from the login heading) was approved and acknowledged (`review-b082ae718ab3f9a5`, authority burned). The #80 and #79 slices, assessed from temporary detached worktrees removed afterwards, were not due (`under_budget`, medium). Advisory findings handled as follow-up: R1 (ADR 0027 claimed a data-neutral rollback; corrected — saves drop the stored key, so a rollback reads the old default) and R3 (stored `version4: true` was untested; the legacy-key test now covers both values, 8/8 in that file). No meaningful RED: behaviour was already correct.
- L11 — Closure: draft PR https://github.com/Dreamcoder08/sipges/pull/81 (base `feat/production-candidate-dashboard`). Remote CI blocked by GitHub account billing (jobs not started), so only local proof exists. Inherited tasks mascli-4-situations T8 and media-monitoring T5 closed on the same evidence. Deployment needs the owner's separate word.
