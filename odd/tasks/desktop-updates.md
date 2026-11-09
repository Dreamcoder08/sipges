# Desktop updates

Deliver an installed-app update experience separate from the contributor's Git clone. Work only in disposable local installations until verification and explicit release publication.

## Specs

- S1 — "yo pensaba que ha medida que hacia cambios y mejoras en la instalacion que tenga crystell le aparesca una notificacion para que actualize y se actualize asi como hace herdr-app esta semana..."
- S2 — "yes te autorizo todo and continue de forma autonoma"
- S3 — "hagamos primero todo en local" (existing constraint; cloud work remains deferred).

## Tasks

- T1 [in_progress] — S1–S3 — Establish a reproducible managed desktop package runnable without the contributor checkout; select a version/feed and safe state layout from observed proof. Route: parent + bounded worker (context backstop). Commit: pending. Risk: item 5 (packaging/runtime).
- T2 [pending] — S1–S3 — Implement signed release verification and an atomic, recoverable local update transaction over managed installations, with synthetic public-interface tests. Route: bounded worker. Commit: pending. Risk: items 1, 2, 4, 5 (state, trust, locking and install).
- T3 [pending] — S1–S3 — Integrate opt-in update notice/approval and managed desktop startup, preserving development clones; document setup, backups and failure recovery. Route: bounded worker. Commit: pending. Risk: items 2, 5 (update authority/install).
- T4 [pending] — S1–S3 — Independently verify the managed update, refusal and recovery paths, check combined tests and hand off a local synthetic demonstration with explicit platform/release limits. Route: gentle-ai-verify + parent. Commit: pending. Risk: items 1, 2, 4, 5.

## Log

- L1 — User: "yo pensaba que ha medida que hacia cambios y mejoras en la instalacion que tenga crystell le aparesca una notificacion para que actualize y se actualize asi como hace herdr-app esta semana..."
- L2 — Accepted proposal explained versioned, verified releases; update notice and explicit approval; separation of installed app from contributor Git clone; backup/data separation, safe stop/start/readiness, and recovery without pretending code downgrade reverses database migrations. Two implementation options were described (managed launcher updater or fully packaged native desktop); technical selection follows T1 evidence, not invented availability.
- L3 — User: "yes te autorizo todo and continue de forma autonoma"
- L4 — Preserve all existing user data, main checkout, installed launchers and localhost8000. No push, main merge, production migration, cloud deployment, public release, real signing credential or private data use in this cycle. Use only synthetic installs and test keys. Missing production signing/distribution setup must disable updates rather than imply a live release channel. Windows execution cannot be claimed from Linux.
- L5 — Worktree .worktrees/desktop-updates, branch feat/desktop-updates, base228daf43 (local integration). The three Settings shortcut edits remain uncommitted in .worktrees/local-integration with test timeouts recorded; do not lose, copy silently or claim them verified. Do not touch or restart the existing synthetic preview18080.
- L6 — Current desktop shortcuts point into source clones; state is separate but port8000 is fixed and process ownership is not coordinated. Node API applies forward migrations at boot. Docker update/backup scripts are reference only, not reusable PGlite operations. Need a managed distribution that never modifies contributor clones; no background git pull, no browser authority to execute updates, no automatic DB downgrade.
