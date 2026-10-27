# MASCLI 4.0 as the only behaviour

Retire the per-project MASCLI 3.0/4.0 switch (ADR 0020 §1) so every project runs MASCLI 4.0.
Supersedes S10 of [mascli-4-situations](mascli-4-situations.md). Branch `feat/mascli-4-only`,
stacked on `feat/production-candidate-dashboard` (`f512d8d`).

## Specs

- S1 — «te autorizo todo y avanza de forma autonoma , se supone que ahora todo debe decir MASCLI 4.0 , verdad ??»
- S2 — «quiero que todo este en 4.0 , objetivo actualizar todo , eliminar redundancia objetivo estar en la vanguardia»
- S3 — Replaces mascli-4-situations S10 («lo que funciona en MASCLI 3.0 se mantiene. Las mejoras forman MASCLI 4.0, activable por proyecto y desactivada por defecto»): every project behaves as MASCLI 4.0; the switch and the 3.0-only branches are removed (S2).

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
- Visible branding names the product MASCLI 4.0. The `/system/v4/settings` path stays (no
  extra route churn); its contract drops `version4`.
- Deployment, production activation and real data still need the owner's separate word.

## Tasks

- T1 [x] S2,S3 — ADR 0027 superseding ADR 0020 §1; update ADR index, mascli-4-situations S10/T8 and media-monitoring S5 with verbatim log entries; route: inline docs; commit: pending
- T2 [ ] S2,S3 — API + contracts: remove the switch from settings, ports, compose and routes; make 4.0 rules unconditional; update API tests (one RED per rule first); route: worker; commit: pending
- T3 [ ] S1,S2,S3 — Web + E2E: remove `useVersion4`, `Version4Only`, `VERSION4_PATHS`, the toggle and 3.0-only paths; MASCLI 4.0 branding; update web and E2E tests; route: worker after T2; commit: pending
- T4 [ ] S2 — Verify: full API/web, lint/types/boundaries, E2E, differential against `f512d8d`; independent verifier (risk item 3: consumed contract; item 2: two-person rule); route: serial checks + verifier; commit: with T2/T3 evidence
- T5 [ ] S1,S2 — Close: evidence, ODD log, draft PR stacked on #80; route: inline; commit: final

## Risk

Item 3 (contract): plan closing without a file now fails with `evidence_required`; GET/PUT
settings drop `version4`; tenant export no longer reflects the switch. Item 2 (guards): the
two-person rule becomes universal. Outbound RSS now depends only on configured feeds.
No database migration and no stored-record rewrite.

## Log

- L1 — Original request verbatim: «te autorizo todo y avanza de forma autonoma , se supone que ahora todo debe decir MASCLI 4.0 , verdad ??». Clarification asked with four options (keep opt-in, enable demo project, default for new projects, rebrand only); answer verbatim: «quiero que todo este en 4.0 , objetivo actualizar todo , eliminar redundancia objetivo estar en la vanguardia».
- L2 — Read-only map (explore mvq4armt-3-7p62), parent spot-checked `settings.ts:35-139`, `actions.ts:117-119`, `compose.ts:380,393,463` and migration 0025 (settings are `jsonb`; the switch lives only in code defaults). 31 TypeScript files reference the switch. The two open questions of the map (URL-only closing; RSS for every tenant) are resolved by S2 «todo este en 4.0»: file required, RSS limited to configured, unpaused feeds.
- L3 — CI for PRs #79/#80 did not start: GitHub reports failed account payments or spending limit. Not a code defect; owner action in Billing & plans. Engram tools are unavailable in this session, so this document has no memory mirror.
