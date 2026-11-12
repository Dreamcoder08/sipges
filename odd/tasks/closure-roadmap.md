# Closure roadmap

Master plan for everything already decided and still unfinished in SIPGES: integration, desktop, cloud and backup,
interface, and real data. It orders the open tasks of the existing feature documents and adds the missing ones. Each
task names its source document; that document stays the place where the work is logged and closed.

## Specs

- S1 — «ayudame para toda la planificacion , lluvias de ideas del proyecto , crea las task increiblemente detalladas»
- S2 — Scope chosen by the owner: «Cierre completo (recomendado)», described as «Integración, escritorio, nube y
  respaldo, interfaz: todo lo ya decidido que falta ejecutar.»
- S3 — Format chosen by the owner: «Un roadmap maestro (recomendado)», described as «Un solo documento ODD con fases,
  dependencias y tareas detalladas que apuntan a los documentos existentes.»
- S4 — Location chosen by the owner: «Worktree nuevo desde main (recomendado)», described as «Rama docs/roadmap en
  .worktrees/roadmap, sin tocar este checkout ni tus cambios sin commitear.»

- S5 — «lo que pasa es que los datos reales de mi prima ya estan en la version de escritorio instalable en local de
  la laptop de mi prima crystell , tamien mejorar el sistem desing and diseño ui & Ux de vanguardia»
- S6 — «mi idea es avanzar con todo lo necesario para despues ir donde mi prima crystell instalar la version
  definitiva , agregarle o extraer sus datos y listo , entiendes ??»

## Tasks

Goal set by S6: one visit to the laptop. Everything is finished and rehearsed beforehand; on the visit the
definitive version is installed and the existing real data is carried into it. Order: phase 0, phase 1 with T33,
phases 3 and 5, then T34. Phase 2 (cloud) and phase 4 do not block the visit.

First, before anything else (S5: real data already lives on one laptop with no proven backup):

- T26 [ ] — S5: back up the real state folder on the laptop today. Route: owner on the laptop. Commit: n/a.
- T27 [ ] — S5: record what is installed on the laptop. Route: owner on the laptop, parent reads the answers. Commit:
  n/a.

Phase 0, integration (nothing else is safe to build until `main` holds the verified units):

- T1 [x] — S2: merge train #391 → #392 → #394 → #393 → #395. Route: owner authorises each merge. Done: #391, #392, #394, #393, #395 merged (main a5825d36).
- T2 [x] — S2: land the local-integration leftovers (Bandeja fix, Settings shortcuts). Route: inline. Done: PR #400 (draft).
- T3 [x] — S2: triage the other open PRs (#397, #381, #338). Route: inline, owner decides #338. Done: #381 merged; #397 superseded by #398 (owner closes); #338 owner.
- T4 [x] — S2: Go integration tests skip without a database instead of panicking. Route: inline. Done: PR #399 (draft).
- T5 [ ] — S2: bring the root checkout to `main` and retire finished worktrees. Route: owner confirms each removal.
  Commit: n/a.

Phase 1, desktop (the nearest real use; does not depend on the cloud):

- T6 [x] — S2: finish the managed package (desktop-updates T1). Route: one worker. Done: feat/desktop-updates a1aabaf4..e3ae3347.
- T7 [x] — S2: signed release check and recoverable update transaction (desktop-updates T2). Route: worker, then
  verifier. Done: feat/desktop-updates, T2 commits plus correction round 4f1d7fee.
- T8 [x] — S2: update notice and approval at startup (desktop-updates T3). Route: inline. Done: feat/desktop-updates 544e9283..9738a024.
- T9 [x] — S2: independent verification of update, refusal and recovery (desktop-updates T4). Route:
  gentle-ai-verify. Done: two verifier passes, see L7.
- T10 [ ] — S2, S5: check the existing Windows install without risking its data. Route: owner on the laptop, parent
  reads the evidence. Commit: pending (fixes only).
- T11 [x] — S2: local backup and restore drill for the desktop state folder. Route: inline. Done: PR #401 (drill on Linux; procedure in deploy/desktop/README*.md).

- T33 [x] — S6: carry an existing install's data into the definitive version, rehearsed. Route: worker, then
  verifier. Done: PR #401 (`rehearse.mjs e490339c` → no difference; rerun with the T27 commit).
- T35 [x] — S6: shortcuts start the managed launcher; the halt reaches the user. Route: worker, then verifier.
  Done: PR #401 (Linux; Windows static only).
- T34 [x] — S6: the visit, by a written runbook. Route: owner on the laptop. Done: runbook docs/deployment/desktop-visit.es.md, PR #401 (91cdbc7c).

Phase 2, cloud and backup (blocked until the Neon quota resets on Dec 1):

- T12 [ ] — S2: resume deploys and stop the quota from pausing production again. Route: owner decision, then inline.
  Commit: pending.
- T13 [ ] — S2: production check of the external-AI switch (ai-egress-privacy T3, functional-closure T5). Route:
  inline with the browser, owner signs in. Commit: n/a.
- T14 [ ] — S2: R2 evidence backup and a drilled Neon + R2 restore (functional-closure T18). Route: worker, then
  verifier; needs the owner's Cloudflare access. Commit: pending.
- T15 [ ] — S2: E2E run against the deployed URL and the four readiness inputs. Route: inline. Commit: pending.

Phase 3, interface (no external blocker; fills gaps between the other phases):

- T16 [x] — S2: close Territorio and Análisis as tabbed views (workspace-architecture T5). Route: inline. Done: PR #402.
- T17 [x] — S2: reconcile Configuración by sections (compact-sidebar T4). Route: inline. Done: PR #402 (remainder: Cuenta section, owner decides).
- T18 [ ] — S2: mobile visual pass and compact-sidebar T2. Route: inline. Commit: pending.
- T19 [x] — S2: one source for the IRSA pending-badge text. Route: inline. Done: PR #402.

Phase 4, real data and owner decisions:

- T20 [ ] — S2: GEOCATMIN against the live service (territorial-intelligence-alerts T1, T2). Route: inline. Commit:
  pending.
- T21 [ ] — S2: push received on a real phone (territorial-intelligence-alerts T8). Route: owner with the phone.
  Commit: n/a.
- T22 [ ] — S2: AMSAC review queue and El Algarrobo's location (functional-closure T25). Route: owner in the product.
  Commit: n/a.
- T23 [ ] — S2: actor identity reconstruction (actor-identity-register T2, T3). Route: inline plus verifier, inside
  the scope the owner authorises. Commit: n/a.
- T24 [ ] — S2: original documents and user acceptance (data-quality-relationships-followup T6). Route: owner.
  Commit: n/a.
- T25 [ ] — S2: record the pending owner decisions. Route: owner. Commit: pending.

Phase 5, design system and interface (S5):

- T28 [x] — S5: audit the design system against the running app. Route: inline. Done: design/vanguard branch 1cd53f6d (system.md re-synced; audit in L10).
- T29 [x] — S5: UX audit of the seven destinations. Route: one explorer, then inline. Done: audit in L10.
- T30 [x] — S5: design directions on the canvas, owner picks. Route: gentle-design. Done: decision in L11.
- T31 [ ] — S5: build the chosen direction in slices. Route: inline per slice. Commit: pending.
- T32 [ ] — S5: accessibility and speed budgets enforced in CI. Route: inline. Commit: pending.

## Task detail

Every task that changes code follows the repository rules: synthetic data only, one failing test per rule first,
`pnpm verify` before the commit, and no push, merge or deploy without the owner's word.

### T26 — Back up the real data now

- Why first: the laptop holds real data in `%LOCALAPPDATA%\SIPGES` (`pglite`, `uploads`, `data-key`,
  `admin-password`). The documented update path is `git pull` and rerun the installer, which runs migrations on
  that data. The backup procedure was never drilled (T11). One failed update or a disk fault loses everything.
- Steps for the owner, on the laptop:
  1. Close the SIPGES window and end the `node` process that serves it (Task Manager), so the database is not
     copied mid-write.
  2. Copy the whole `%LOCALAPPDATA%\SIPGES` folder to an external drive, in a folder named with the date.
  3. Check that the copy has the same number of files and total size as the original.
  4. Keep the drive away from the laptop. The folder contains the encryption key and the admin password: whoever
     holds the copy can read the data, so it must not go to a shared or cloud folder without a decision (T25).
  5. Open SIPGES again and confirm it works.
- Rule until T7 is done: no `git pull`, no installer rerun and no update on the laptop without a backup taken the
  same day.
- The parent never receives, opens or copies this folder.
- Done when: the owner confirms the dated copy exists and the app still opens.
- Risk: item 1.

### T27 — What is installed

- Needed because every later desktop task depends on it, and nothing in the repository records it.
- Questions for the owner, answered from the laptop:
  1. How it was installed: clone plus `install.ps1`, or another way; from which repository (the owner's or a fork).
  2. The installed version: `git log --oneline -1` in the cloned folder.
  3. Windows version, `node --version`, `pnpm --version`, PowerShell version.
  4. Whether MFA is on, and how many people use it.
  5. Size of `%LOCALAPPDATA%\SIPGES` and of `api.log`.
  6. Anything that failed or felt slow so far.
- Done when: the six answers are in this document's Log. They contain no real data.

### T1 — Merge train

- Source: `local-integration.md` (branch `chore/local-integration`, worktree `.worktrees/local-integration`).
- State: #390 is merged (`4031d795`). Drafts open: #391 desktop launchers, #392 fork-ready deploy, #394 fork
  collaboration (its base is `feat/fork-ready-deploy`, not `main`), #393 IRSA insufficient data, #395
  OpenAI-compatible narrator.
- Steps, one PR at a time:
  1. Rebase or update the branch on current `main`; mark the PR ready.
  2. Wait for CI (`ci.yml`, `go.yml`, `rust.yml`); a red check stops the train.
  3. Owner merges. After #392 merges, retarget #394 to `main` before touching it.
  4. After #393, confirm the rebuilt `analytics.wasm` matches the hash recorded in `irsa-insufficient-data.md` L5.
- Proof that the five units work together already exists locally: `pnpm verify` passed on the combined tree (API
  1121, web 517, hosting 126, tooling 47) and the web build passed. Use it as the reference, not as a substitute for
  CI on each PR.
- Deploy: every merge to `main` triggers `deploy-workers.yml`, which stops at migrations while Neon is paused. Expect
  failed deploy runs until T12; they do not block the merges.
- Done when: the five PRs are merged, `main` CI is green, and `git log origin/main` holds the five branch tips.
- Risk: item 5 (delivery). #395 also touches item 2 (the narrator reads an API key).
- Owner input: the word to merge each PR.

### T2 — Local-integration leftovers

- Source: `local-integration.md` T4 and L9; `desktop-updates.md` L5.
- Two pieces live only in `.worktrees/local-integration`:
  - Commit `8a47048`: the Bandeja duplicate fix, three `DecisionInbox` files.
  - Three uncommitted Settings shortcut edits, with test timeouts recorded. The log says: «do not lose, copy
    silently or claim them verified».
- Steps:
  1. In that worktree run `git status --short` and `git diff --stat`; write the exact file list into this
     document's Log before anything else.
  2. Branch `fix/bandeja-and-settings-shortcuts` from `main` after T1; cherry-pick `8a47048`.
  3. Carry the three Settings edits over as a patch, then read them: keep only what a test or the owner's request
     explains. Ask the owner about any edit with no recorded reason.
  4. Run the web tests for `DecisionInbox` and Settings, then `pnpm verify`.
- Done when: a PR holds both pieces with their tests and `.worktrees/local-integration` has no change that is
  missing from `main` or from that PR.
- Risk: none expected (web only); confirm after reading the Settings diff.

### T3 — Other open PRs

- #397 «Update README with project details and version» (owner's branch `Dreamcoder08-patch-1`): compare with the
  README on `main`; report conflicts with `repo-cleanup.md` T12, which defers README corrections.
- #381 dependabot, `ureq` 3.5.0 → 3.5.1 in `engines`: merge when `rust.yml` is green.
- #338 «declare the Go container in production with no routes» (draft): belongs to the Go cutover, which is out of
  this roadmap (see Out of scope). Owner chooses: keep as draft or close.
- Done when: each of the three is merged, closed, or has a recorded reason to stay open.

### T4 — Go tests without a database

- Source: `local-integration.md` L5; `model-agnostic-analyst.md` L3. The Go integration command panics at
  `assisted_integration_test.go:69` when `SIPGES_TEST_DATABASE_URL` is unset. It also fails on `main`.
- Steps:
  1. Reproduce: run the Go integration package with the variable unset and keep the panic output.
  2. Find every Go test helper that reads the variable; make each call `t.Skip` with one clear message.
  3. Check that CI sets the variable, so nothing becomes silently skipped there: the skipped count in `go.yml` must
     stay at zero.
- Done when: the command exits 0 locally without a database and reports the skips; CI runs the same tests as before.
- Risk: item 6 if a skip hides tests in CI; step 3 is the guard.

### T5 — Root checkout and worktrees

- State: the root checkout is on `design/compact-sidebar`, 1098 commits behind `main`, with untracked
  `design/app-icon/`, `design/workspace-architecture/.screenshots/` and `logs/`. There are 17 worktrees under
  `.worktrees/` plus others outside the project.
- Steps:
  1. For each worktree branch, record `git rev-list --count origin/main..<branch>` and `git status --short | wc -l`.
  2. Classify: merged and clean (removable), unmerged (keep), dirty (keep and list the files).
  3. Show the owner the table. Remove only the rows the owner confirms, with `git worktree remove` (never
     `--force`) and `git branch -d` (never `-D`).
  4. Root checkout: move the untracked design folders somewhere the owner chooses, or commit them if the owner
     approves icon 01 (T25); then `git switch main` and fast-forward.
- Done when: the root checkout is on current `main` and every remaining worktree has a named reason.
- Risk: item 1 (deleting a worktree with uncommitted work cannot be undone). Worktrees outside the project
  (`~/.codex`, `~/orca`) are not touched.

### T6 — Managed desktop package

- Source: `desktop-updates.md` T1 (`.worktrees/desktop-updates`, branch `feat/desktop-updates`, 9 uncommitted
  paths).
- Built so far: `deploy/desktop/package/builder.mjs` with 6 tests, `createManagedReferenceReader` in
  `apps/api/src/contexts/reference/infrastructure/file-reference-reader.ts`, the `SIPGES_REFERENCE_DIR` absolute
  check in `apps/api/src/platform/config.ts`, and the generated `start.mjs`.
- Rule from the L12 incident, to apply first: mock or block every legacy filesystem read in these tests, including
  the failing run against the old code. A failing test once read a repository dataset; never inspect or copy that
  output.
- Steps:
  1. Add the legacy-read block to the test setup and prove it: a test that fails if the legacy reader opens a file.
  2. Add the missing reader cases, one test each: valid coordinate payload, invalid schema, directory symlink,
     non-regular file, legacy behaviour preserved under mock.
  3. Fix the Prettier failure; run typecheck and ESLint again, since the last manual edits were never re-tested.
  4. Build a fresh package under `.data/desktop-packages/` and boot it on a free port (never 8000 or 18080):
     readiness answers 200, web answers 200, and the import guard reports no import outside the package.
  5. Prove source preservation: file hashes of the checkout before and after the build are identical.
- Done when: all tests pass, the package boots from a directory outside the checkout, and the hashes match.
- Risk: item 5 (packaging), item 1 (the builder once rewrote hardlinked sources; step 5 guards it).

### T7 — Signed release and update transaction

- Source: `desktop-updates.md` T2. Nothing is implemented.
- Decisions to settle before code, in the feature document: signature scheme and where the public key ships; where
  releases are published (the owner authorised no publication yet, so the first version reads a local directory);
  what a version is (the package `metadata.json`).
- Rules, one failing test each:
  1. A package whose signature does not match is refused and the installed version is unchanged.
  2. A package older than or equal to the installed version is refused.
  3. The update swaps directories with one atomic rename; a crash at any step leaves either the old or the new
     version runnable.
  4. The state folder (`pglite`, `uploads`, `data-key`, `admin-password`) is never touched by an update.
  5. If the new version fails its readiness check, the previous version is restored and the failure is logged.
  6. A database migration that fails rolls the update back; the previous database is restored from a copy taken
     before the update.
  7. Because of S5: the update starts from the version recorded in T27, not only from the latest one, and the
     first update on the laptop runs on a copy of the state folder before it touches the real one.
- Done when: the seven tests pass and a scripted update from version N to N+1 and a forced failed update both end
  with a running instance and intact synthetic data.
- Risk: items 1, 2 and 5. Own commit and independent verifier (T9).

### T8 — Update notice

- Source: `desktop-updates.md` T3; the owner's words in S1 there: a notification appears and the person chooses to
  update.
- Steps: a version check at startup against the release source; a notice in the web shell with the new version and
  what changed; an explicit button; nothing downloads or installs before the click; a failed check stays silent
  apart from one log line.
- Tests: notice shown only when a newer signed version exists; declining keeps the current version and does not ask
  again until the next start; the notice never appears in the cloud build.
- Done when: the three tests pass and the flow runs end to end on Linux against a local release directory.
- Risk: none beyond T7.

### T9 — Independent verification of the updater

- Source: `desktop-updates.md` T4. Runs after T6–T8 on a fresh subagent that reads the whole feature document.
- Scope: tampered package, downgrade, interrupted update at each step, failed migration, full disk, state folder
  untouched. Verdict per spec.
- Done when: every spec has a verdict; blockers are fixed test-first or returned to the owner.

### T10 — First run on Windows

- Source: `desktop-launchers.md` S1 and L3; `deploy/desktop/README.md` Limits: Windows was checked by reading the
  scripts only.
- S5 changed this task: the laptop already has a working install with real data, so nothing is reinstalled there.
  Lines 1–3 are checked on a second Windows user account or another machine, with an empty state folder. Lines 4–9
  are read-only checks on the real install, after T26.
- Checklist, in order, noting pass or fail for each line:
  1. `node --version` is 24 or higher; if not, `winget install OpenJS.NodeJS.LTS` and open a new terminal.
  2. Fork and clone under the user's own GitHub account.
  3. Run `deploy/desktop/windows/install.ps1` with `-ExecutionPolicy Bypass`. Known low-severity risks: the npm
     prefix can print garbled under PowerShell 5.1; an older `pnpm` on `PATH` stops the installer.
  4. `%LOCALAPPDATA%\SIPGES` holds `pglite`, `uploads`, `data-key` and `admin-password`.
  5. The «SIPGES» shortcut exists in the Start menu and on the desktop.
  6. Open it: within 90 seconds Edge opens in app mode on `http://localhost:8000`.
  7. Sign in as admin and set up MFA.
  8. Create one record, close the window, reopen from the shortcut: the record is there.
  9. Restart Windows and open again.
- On any failure: copy `%LOCALAPPDATA%\SIPGES\api.log` and the text of the message box, open an issue with the
  template from #394, and stop.
- Done when: the nine lines pass, or each failure has an issue and a fix with a test.
- Depends on: T26, T27; T1 for lines 1–3.

### T11 — Desktop backup and restore

- Source: `deploy/desktop/README.md` (backup: stop the server, copy the state folder, restore to the same path).
  Never drilled.
- Steps on Linux with synthetic data: create records and one upload; stop; copy the state folder; delete the
  original; restore; start; confirm the records, the upload and the sign-in. Then write the same steps into both
  READMEs as a numbered procedure, with the Windows paths.
- Done when: the drill passes once from a clean folder and the documented steps are the ones that were run.
- Risk: item 1; work only on a scratch state folder, never the instance on port 8000.

### T33 — Data from the old install into the definitive version

- Problem: the laptop runs an older version (exact commit unknown until T27) with real data in a PGlite database,
  uploads, an encryption key and an admin password. The definitive version has newer migrations and the managed
  package layout from T6. Nothing has ever proved that an old state folder opens under the new version.
- Two paths; build the first, keep the second as the fallback:
  1. In place: the definitive version starts on a copy of the old state folder and migrates it forward.
  2. Extract and load: export every project from the old install to a file and import it into a fresh definitive
     install. Check first which export and import the product already has; add only what is missing.
- Rehearsal, with synthetic data only:
  1. Check out the commit from T27 in a scratch worktree; start it on a scratch state folder; load synthetic
     records, links, uploads, users with MFA, and audit entries for two projects.
  2. Stop it. Copy the folder. Start the definitive package on the copy.
  3. Compare before and after through the public API: row counts per module and project, a sample of records
     field by field, every upload by hash, sign-in with the old password and MFA, audit entries intact.
  4. Repeat from every tagged version between the T27 commit and the definitive one if migrations were added.
- Rules, one failing test each: a migration failure leaves the copy unusable but the original untouched; the
  encryption key from the old folder decrypts under the new version; rows of one project never appear in another
  after the move; a second run on an already migrated folder changes nothing.
- Done when: the rehearsal passes from the T27 commit and the comparison script prints no difference.
- Risk: items 1 and 2. Own commit, independent verifier.
- Depends on: T27 (only the commit hash is needed, it can be sent by message), T6.

### T35 — Shortcuts and the halt message

- Source: second verifier pass on the updater (L7). The update works, but the Windows and Linux shortcuts still start
  the clone-based launcher, and a halted update (exit 3 after `ROLLBACK_INCOMPLETE`) only writes to stderr: the
  browser shows «Actualizando…» and then «SIPGES no respondió».
- Steps, test first:
  1. Both installers create the managed install (`versions/`, `current.json`, state folder) and point the shortcut at
     `updater/launcher.mjs`.
  2. A halted start shows a Spanish message the user sees (Windows message box, Linux notification or page), naming
     the backup to restore.
  3. A documented way out of the halt after restoring one's own backup, without deleting files by hand.
  4. Update check: try the newest release first and stop at the first that verifies (check time no longer grows with
     each release kept).
  5. Stopping during the click re-check cancels the update.
  6. `SIPGES_REFERENCE_DIR` set by the package still reaches the server.
- Verifier probes kept under `.worktrees/desktop-updates/.data/verifier2-probes/` (ignored); add the useful ones as
  tests, with the race test at three processes.
- Done when: the six steps pass on Linux and the Windows steps are written for T34's rehearsal.
- Risk: items 1 and 5.

### T34 — The visit

- A printed runbook, `docs/deployment/desktop-visit.es.md`, in Spanish, with a box to tick per step:
  1. Back up the state folder to the external drive (T26 steps), unless a backup from that day exists.
  2. Record the old version and the counts shown on Inicio for each project.
  3. Install the definitive version beside the old one, not over it.
  4. Run the T33 move on a copy of the state folder.
  5. Compare the counts with step 2; open ten records and three uploads chosen by the user.
  6. The user signs in, with MFA, and works for ten minutes on her own tasks.
  7. Point the shortcut to the new version. Keep the old install and the backup for thirty days.
  8. Show her the update notice (T8) and the backup procedure (T11).
- Stop rule: any difference in step 5 means the old version stays in use and the laptop is left as it was.
- Entry conditions: T6–T9, T11 and T33 closed; the full runbook rehearsed once on another Windows machine or user
  account (T10 lines 1–3).
- Done when: the eight boxes are ticked and the owner records the date here.
- Risk: item 1.

### T12 — Deploys and the Neon quota

- Source: `go-rust-stack.md` L70: production answered 503 on 2026-11-06 because Neon paused the project at the free
  plan limit (6.72 GB transfer, 18.53 CU-hours since Nov 1). The trial branch shares the quota. It resets Dec 1.
- Owner decision, before Dec 1: stay on the free plan and remove what drains it, or move to a paid plan.
- Steps if the free plan stays: delete or suspend the trial branch of production; measure CU-hours per day for a
  week from the Neon console; add the quota to the instance runbook with the date it resets.
- Steps on Dec 1: run `deploy-workers.yml` by hand; watch migrate, deploy, `/health/ready` and `smoke-go.mjs`.
- Done when: a deploy from `main` is green and the runbook says how to see the remaining quota.
- Risk: item 5.

### T13 — External-AI switch in production

- Source: `ai-egress-privacy.md` T3; `functional-closure.md` T5. The switch is `externalAi.enabled` in
  `apps/api/src/contexts/situations/domain/settings.ts`, default `false`, stored per project.
- Steps with the owner signed in: open Configuración for each of the two projects and read the switch; try one path
  that would send data out; confirm the refusal on screen and an «IA externa» entry with action `EGRESS` in
  Auditoría. Record the date and the two results in both source documents.
- Done when: both projects show the switch off and a refused, audited attempt.
- Depends on: T12. Risk: item 2.

### T14 — Backup and restore drill

- Source: `functional-closure.md` T18; `docs/deployment/readiness.md` (restore drill: not done). The `EVIDENCE` R2
  bucket is bound; there is no backup script, schedule or restore script.
- Steps:
  1. Decide in the feature document: what is backed up (PostgreSQL and the evidence bucket, taken together), how
     often, how long it is kept, where it goes, and who can read it.
  2. Backup script plus a scheduled workflow; secrets by reference only.
  3. Restore script that targets a disposable Neon branch and a scratch bucket, never production.
  4. Drill with synthetic data: back up, restore, compare row counts per table and object hashes, time it.
  5. Write the measured restore time and the steps into `docs/operations/handover.md`.
- Done when: one drill passes end to end and its date and duration are in the handover document.
- Risk: items 1, 2 and 5. Own commit, independent verifier.
- Owner input: Cloudflare access and the retention period.

### T15 — E2E against the deployed URL

- Source: `docs/deployment/readiness.md`: E2E against the deployed URL not done; four operator inputs missing
  (synthetic least-privilege PostgreSQL, disposable restore environment, institutional owners, activation decision).
- Steps: a Playwright project that takes the base URL from a variable and uses a synthetic project and account
  only; run the navigation, record and document specs; record the result in `readiness.md`. Ask the owner for
  inputs three and four.
- Done when: the run passes against production and `readiness.md` has no row marked «Not done».
- Depends on: T12, T14.

### T16 — Territorio and Análisis tabs

- Source: `workspace-architecture.md` T5. The `/territorio` and `/analisis` tab routes exist since `b664c5d` but
  the task has no dedicated commit or check.
- Steps: read `apps/web/src/app/navigation.ts` (`DESTINATIONS`); for each view (mapa, ubicacion, cronologia; irsa,
  riesgo, situacional, estrategica, lecciones, redes) confirm the tab opens with `?vista=`, the old route
  redirects, the selected tab survives a reload, and the keyboard reaches every tab. Add the missing cases to
  `apps/e2e/tests/hubs.mobile.spec.ts` and a desktop hub spec.
- Done when: every view has a passing check and the task is closed in its document with the commit.

### T17 — Configuración by sections

- Source: `compact-sidebar.md` T4, which its L8 says continued as `functional-closure.md` T6 and T7, both closed.
- Steps: compare S7 of `compact-sidebar.md` with the current `/version-4` screen (`?seccion=`), section by
  section. Close T4 with the commits that delivered it, or list what is missing and build only that.
- Done when: T4 is closed with evidence or reduced to a named remainder.

### T18 — Mobile visual pass

- Source: `local-integration.md` L7: mobile visual unverified. `compact-sidebar.md` T2: check against the artboard.
- Steps: run the mobile Playwright specs (`mobile.spec.ts`, `hubs.mobile.spec.ts`, `inicio.mobile.spec.ts`,
  `settings.mobile.spec.ts`) with screenshots on; compare Inicio, Registros, Bandeja, Territorio, Análisis,
  Integraciones and Configuración at phone width with the artboards in `design/`; fix overflow, clipped text and
  tap targets under 44 px, each with a test.
- Done when: the specs pass, the screenshots are reviewed by the owner, and compact-sidebar T2 is closed.

### T19 — IRSA pending badge

- Source: `irsa-insufficient-data.md` L4: the badge text is duplicated in `dashboard/IrsaStatus.tsx` and
  `indicators/IrsaPage.tsx`.
- Steps: one shared constant or component; a test that both screens show the same text.
- Done when: the text lives in one place. Depends on: T1 (#393).

### T20 — GEOCATMIN live

- Source: `territorial-intelligence-alerts.md` T1, T2 and L11: the `SERV_*/MapServer?f=json` services answer, but
  the server omits its intermediate certificate (Sectigo OV R36), so Node and curl fail with «unable to get local
  issuer certificate».
- Steps:
  1. Reproduce with one read-only request to one `SERV_*` endpoint and keep the error.
  2. Find out whether the production runtime (Cloudflare Workers `fetch`) fails the same way; it may complete the
     chain itself. This decides whether any code changes.
  3. If it fails: supply the intermediate certificate to that adapter only. Never disable certificate checks.
  4. Run the catalogue and concession queries against the live service for one synthetic area and record URL, CRS,
     scale and timeout results.
- Done when: T1 and T2 are closed with a live result, or the service's fault is recorded with the date and a
  recheck date.
- Risk: item 2 (TLS trust).

### T21 — Push on a real phone

- Source: `territorial-intelligence-alerts.md` T8. Settings by name: `SIPGES_VAPID_PUBLIC_KEY`,
  `SIPGES_VAPID_PRIVATE_KEY`, `SIPGES_VAPID_SUBJECT`.
- Steps: generate keys with `tools/vapid-keys.ts`; the owner stores them as secrets; subscribe from the installed
  app on the phone; trigger one synthetic alert; confirm it arrives and opens the right screen.
- Done when: one notification is received and the task is closed with the date.
- Depends on: T12.

### T22 — AMSAC queue

- Source: `functional-closure.md` T25: 2,615 Sechura and 2,056 El Algarrobo items wait for review in Bandeja ›
  Validación (`/system/document-lab/review`, bulk and single endpoints). El Algarrobo's location is still to be
  saved in Configuración; L9 and L11 record its extent.
- Steps for the owner: review by batches with the bulk action; save the location. The parent only reads counts
  before and after.
- Done when: the queue count is zero or the remainder has a recorded reason.
- Depends on: T12.

### T23 — Actor identities

- Source: `actor-identity-register.md` T2 (source-backed reconstruction preview) and T3 (apply only previewed
  changes inside the scope the owner authorises, then verify).
- Steps: read the whole document first, including why T3 stopped; produce the preview; the owner approves the
  scope in writing; apply; independent verifier compares before and after.
- Risk: item 1 (rewrites stored records). Own verifier.

### T24 — Originals and acceptance

- Source: `data-quality-relationships-followup.md` T6. No original documents were found in the workspace; needs a
  real user.
- Steps for the owner: say where the originals are, or that they are lost. If lost, close the task as dropped with
  that reason, so it stops showing as open.

### T25 — Owner decisions

Each line needs one answer from the owner; record it in the named document.

- Merge of #391, #392, #394, #393, #395 (T1).
- Neon: free plan without the trial branch, or a paid plan (T12).
- Ley 29733: data-processing decision before real data reaches an external model (`workspace-architecture.md` T8).
- Minimum evidence for an IRSA score (`irsa-insufficient-data.md` L4); today one record in any dimension is enough
  to leave «insufficient data».
- Icon 01 (organic terrain): approve to commit `design/app-icon/`.
- Session cache and GIN search (`backend-latency.md` T7): the cache delays session revocation; GIN changes
  substring matching to word matching and has no measurement yet.
- Backup retention period (T14).
- Skip `migrate` on dry run (`repo-cleanup.md` F1).

### T28 — Design system audit

- Reading of S5: «sistem desing» is taken as the design system (tokens, components, themes). If the owner meant the
  software architecture, say so and this phase gets an architecture task instead.
- Sources: ADR 0018 (tokens and themes), ADR 0019 (OLED dark, conversational UI), `design/system.md`, the artboards
  under `design/`.
- Steps:
  1. Run the design-system sync so `design/system.md` matches current `main`; the copy in the root checkout is 1098
     commits old.
  2. List every colour, spacing, radius, shadow and font size used in `apps/web/src` that is not a token.
  3. List components that exist more than once with different looks (buttons, chips, cards, empty states, tables).
  4. Check both themes for contrast: text 4.5:1, large text and icons 3:1.
- Done when: a table of findings with `path:line`, ordered by how many screens each one touches.

### T29 — UX audit

- Scope: Inicio, Registros, Territorio, Bandeja, Análisis, Integraciones, Configuración, on desktop and phone width.
- For each, with synthetic data: the main job of the screen and how many steps it takes; what the screen shows when
  empty, loading, failing and with 5,000 rows; keyboard path; where a first-time user would hesitate. Use the
  questions in T27 line 6 as real evidence of friction.
- Done when: at most ten problems, each with a screenshot, its cost to the user and a proposed change. No redesign
  of things that work.

### T30 — Directions

- Steps: three directions for the two screens used most (Inicio and Registros) plus the shared shell, as artboards
  under `design/vanguard/`, shown on the canvas. Each direction states what it changes in tokens, density, type and
  motion, and what it costs to build.
- Constraints carried from earlier decisions: five destinations and one Integraciones page stay; integrity rules
  stay visible (A–E verification, audit, approvals); works on a phone; works on the laptop without a network.
- Done when: the owner picks one direction or a mix, recorded in the Log.

### T31 — Build the direction

- Slices of about 400 changed lines, in this order: tokens and themes; shell (sidebar, header, mobile drawer);
  shared components; Inicio; Registros; the other destinations.
- Each slice: visual check against the artboard, existing E2E still green, screenshots of both themes at desktop
  and phone width.
- Done when: every destination uses only tokens and shared components, and T28's table is empty.
- Depends on: T30; T16–T18 first, so the redesign starts from a closed interface.

### T32 — Budgets in CI

- Steps: an automated accessibility check on the seven destinations in the E2E run (no serious or critical
  violations); a bundle size limit for the web build, set from today's size; a check that Inicio becomes usable
  within a stated time on the laptop-class profile recorded in T27.
- Done when: the three checks run in `ci.yml` and fail the build when crossed.
- Risk: item 5 (CI).

## Out of scope

Not chosen in S2. Each stays open in its own document.

- Analyst: `agentic-analyst.md` T1–T4, cited answers (`workspace-architecture.md` T7b, `functional-closure.md` T14),
  local model.
- Go cutover: `go-rust-stack.md` T44, T69–T71 (wait for the USB and the demo); `repo-cleanup.md` T11, T12;
  `functional-closure.md` T10; `conflict-free-delivery.md` T4.
- New ideas from the brainstorm: explainable IRSA, analysis skills over MCP, offline mode, first-setup assistant,
  instance health board, guided importer.

## Log

- L1 — S1 verbatim, 2026-11-11.
- L2 — State read on 2026-11-11: `origin/main` at `4031d795`; open PRs #391, #392, #393, #394, #395 (drafts), #397,
  #381, #338 (draft); `chore/local-integration` 21 commits ahead of `main`; `feat/desktop-updates` 22 commits ahead
  with 9 uncommitted paths; root checkout on `design/compact-sidebar`, 1098 commits behind.
- L3 — Owner's answers recorded as S2–S4. Document written on branch `docs/roadmap` in `.worktrees/roadmap`.
- L4 — Not verified while planning: the current file list of the uncommitted Settings edits (T2), the merge order
  and conflicts of the local integration (not recorded in its document), and whether Workers `fetch` fails on the
  GEOCATMIN certificate chain (T20).
- L5 — S5 verbatim, 2026-11-11. Effect: T26 and T27 added and placed first; T10 rewritten from a first install to a
  check of the existing install; T7 gained rule 7; phase 5 (T28–T32) added. Slice boundary: the first commit of this
  document is one slice; these changes are the second.
- L6 — S6 verbatim, 2026-11-11. Effect: the visit is the milestone; T33 and T34 added; T26 becomes step 1 of the
  visit unless the user can do it earlier by herself; phases 2 and 4 no longer block the milestone.
- L7 — Execution, 2026-11-12. T1: #391, #392, #394, #393 and #395 merged after merging `main` into each and green
  CI (conflicts in `scripts/tooling.test.mjs` and `.gitignore` kept both sides; #393's install drill failed once on
  the live Defensoría preview, 502, and passed on rerun). Every merge triggered `deploy-workers.yml`, which failed as
  expected: production answers 503 until Neon resets (T12). T4: helpers that touched the scratch database now skip,
  `go test ./...` exits 0 without a database (73 packages). T6–T8 by workers on `feat/desktop-updates`, all local:
  managed package booted outside the checkout; signed updater (38 tests); click-to-update E2E N→N+1 on Linux in
  5.5 s. T9: first verifier found two blockers (launcher restarted after an incomplete rollback; a linked state
  folder got no real backup) and two medium defects (stale lock with a reused pid; damaged package offered); one
  correction round fixed all, and a second verifier confirmed them on Linux with six advisories, carried into T35.
  Not run anywhere: Windows. A stash `engram manifest before merge` was left in `.worktrees/irsa-coverage`.
- L8 — 2026-11-12. T35, T33 and T11 done by workers on `feat/desktop-updates`, pushed as draft PR #401. The data move
  rehearsal from `e490339c` printed `RESULT: no difference` after the first start, after a second run and after a
  backup restore (records, links, uploads by hash, audit, MFA sign-in, 32 isolation probes). A third verifier found six
  blockers (interrupted first start left a child running; installer rerun accepted another state folder; typed values,
  uploads past 500 and old audit rows not compared; installer generated a missing admin password); one correction
  round fixed them and a fourth verifier confirmed all six on Linux. Still unverified: Windows, the real server start
  through `run-current.mjs` after the last boot change (the rehearsal started it through the launcher), the laptop
  commit (T27). Native review of PR #401 refused: the candidate exceeds the reviewer context budget
  (`lens_context_budget_exceeded`); it must be split into smaller PRs to be reviewed natively.
- L9 — 2026-11-12. T16–T19 by a worker on `feat/interface-closure`, draft PR #402: tabs pinned by tests; old routes
  stay deep links (decision: same as Registros and Bandeja, since a redirect changes headings, notification links and
  e2e assertions); Configuración matches S7 except Cuenta (active sessions, sign out everywhere), which needs identity
  API work; touch targets raised to 44 px on touch screens; one IRSA pending badge. Playwright ran locally with
  synthetic data: chromium 89 passed, mobile 46 passed. T18 stays open until the owner reviews the 360 px screenshots
  in `.worktrees/interface/.data/mobile-pass/after/`. T34 runbook written (453 lines); its ⚠ commands were never run on
  Windows, and it needs the T27 answers.
- L10 — 2026-11-12. Root checkout moved to `main` (its branch `design/compact-sidebar` had no commits outside `main`;
  one untracked screenshot identical to the tracked copy was removed). T28/T29 read-only audit: colours fully
  tokenised in modules; duplicates (7 empty states, ~8 chip styles, 8 status badges, 4 alerts, 4 dialogs, 9 tables);
  contrast failures (input and button borders 1.3–1.6:1, `--dim-d` 3.6:1, `--level-yellow` 2.4:1 as a fill, dark
  `--ink-faint` 4.1:1); ten UX problems (Inicio blank bands and clipped chips at 360 px, no retry on a failed summary,
  Registros filter stack and client-side loading of every row, Bandeja hints on touch, IRSA caveat shown twice,
  Integraciones dead-end empty state, no Cuenta). T30: `design/system.md` re-synced and three directions in
  `design/vanguard/` (branch `design/vanguard`, 1cd53f6d): 01 Calma conversacional (≈3 slices), 02 Mesa de operaciones
  (≈6), 03 Mapa vivo (≈9). Shared proposed tokens: `--color-control-border`, `--color-warning(-soft)`,
  `--text-caption`, `--motion-spin`, `--motion-shimmer`; corrected `--dim-d`, `--level-yellow`/`--viz-6` light, dark
  `--ink-faint`. axe: 0 violations in both themes. Waiting for the owner to pick a direction.
- L11 — 2026-11-12. Owner on T30: «me gusta estar en la vanguardia , puedes cuestionar consultando con el modelo fable
  5.2» and «si tienes dudas puedes inspirarte en como lo estan haciendo los mejores del mundo esta semana , mes de 2026
  y mas en la web». Fable 5.2 (claude-fable-5-2, read-only on the artboards) recommended a mix: shell and Inicio from 01
  (attention list first, composer below with two labelled states: «Buscar en registros» while the external model is
  off, «Preguntar, con citas» when on); Registros and Bandeja on desktop from 02 (36 px table with a side detail);
  phone lists from 01 (two-line rows, one filter sheet); Territorio from 03 only inside Territorio (list ↔ numbered
  marker, «sin ubicación» with an action). Not to build: the map as the shell, the filter-grammar parser, saved views,
  J/K, the 80 px rail, server paging for ~200 rows, loading animations. «Vanguardia» here: state honesty (offline,
  AI off, IRSA provisional, layer dates), integrity as material (one status family, A–E and four eyes on every row),
  instant local response (filters and Ctrl+K without waiting, linkable by URL). Web research the same week agreed:
  claims one click from their rows (DesignRush 2026-11-11), compact lists (GitHub dashboard 2026-11-10), light mode for
  dense small type, palette shortcuts shown in place (Linear, Raycast). Decision taken by the parent under the owner's
  delegation: build that mix in seven slices; slice 1 is tokens and states, common to every direction. Also: #401
  split into the stack #403 → #413; native review approved slices 04 and 09 with advisories, fixed in #413.
- L12 — 2026-11-12. Owner: «implementa esto , https://github.com/GoogleChrome/modern-web-guidance». Done in draft PR
  #415 (stacked on #414): the `modern-web-guidance` skill vendored byte-identical (upstream 4dd96834, Apache-2.0) with
  provenance in `skills-lock.json`; `legacy-scan apps/web/src` went from 1 finding to 0 (map sheet animates its height
  with `interpolate-size`); guides `ime-safe-enter-submit` and `scrollability-affordance-hints` applied on Inicio.
  Checked and left as follow-ups: native `<dialog>` for ConfirmDialog and Sheet, interest-triggered tooltips,
  responsive table columns, `:user-invalid` field feedback, IME-safe Enter in SearchPalette. T17 remainder (Cuenta)
  built in draft PR #416: own sessions list, end one, end all others, in TS and Go with parity (2589/2589, 0 unproved
  write routes); independent verifier found no blockers, its advisories fixed test-first; ADR 0004 addendum.
- L13 — 2026-11-12 (Thursday). Owner: «tenemos que seguir avanzando la visita a la casa con la laptop de crystell es
  hasta el sabado o domingo y hoy estamos jueves» and «lo armamos en la laptop de crystell el sabado». All draft PRs
  merged (#399, #400, #402 with #414/#415/#418, #403 with #404–#413, #416, #419). The Windows drill (#419) passed on
  windows-latest: clone install of the old version, managed install over a copy, first start, compare «RESULT: no
  difference», original folder byte-identical, update N→N+1, halt exit 3. #420 adds the drill over the five candidate
  laptop commits, the one-command `visit-kit.mjs` and UTF-8 installer output. Decision: the kit is built and signed
  on the laptop itself on Saturday, from a second clone in a separate folder (never the old clone), with the signing
  key on its own USB.
- L14 — 2026-11-12. Visit readiness on `main`: #420 (Windows drill over the five candidate laptop commits 6d867050,
  228daf43, a73f831a, dc7abde0 and main, all DRILL PASSED; one-command `visit-kit.mjs`; installer output with correct
  accents) and #421 (kit built on the laptop from a second clone: refusals for Node/pnpm, SIPGES open, disk space,
  paths inside the old clone or LOCALAPPDATA SIPGES; Windows rehearsal LAPTOP KIT REHEARSAL PASSED, old clone
  byte-identical; measured on the runner: 867 MB, under half a minute with a warm network; runbook «Paso K»). Still
  owner-side: confirm the laptop commit with `git log --oneline -1`, take the backup, bring two USB drives (or one
  plus `C:\SIPGES-kit-salida`) and network.
- L15 — Recovery after provider/network interruption. Owner: «continue». T31 delivery slices 3 and 4 are merged
  as #422 and #423: desktop Registros grid/detail and mobile Todos rows with the Eventos chip fix. Type-specific
  record screens remain tables on phones; the combined browser run exposed a Territorio actor touch-target failure
  not established against the base, so it remains unresolved rather than dismissed as pre-existing.
  The Inicio and Bandeja workers timed out after a stalled shell call. Recovery confirmed both terminal and no
  matching leftover processes; Inicio has preserved uncommitted edits, Bandeja has none. No surviving evidence
  establishes checks on those edits. Read-only recovery identified a potential false all-clear while Inicio's
  digital/IRSA sources load; reproduce and fix before completion. Resumed as two disjoint work units, no commits
  or publishing by workers, one bounded correction cycle each. Delivery-slice labels 5 (Inicio) and 6
  (Bandeja/search filters) are execution labels under T31, not additional owner requirements. T31 stays open.
  Windows rehearsals do not establish readiness of the actual laptop: its backup, exact commit and acceptance
  remain owner-side and unconfirmed.
- L16 — T31 recovery verification: Inicio's new checks passed 588 unit tests and focused browser probes. The first
  parent gate could not start (`corepack` absent, zero tests); installed pnpm ran it. Two task-created `.data/*.tsx`
  splice files then failed root lint; preserved as text, without weakening lint. The next gate passed, but the full
  browser suite returned 140 passed, 3 skipped, 2 failed: the new Inicio «Abrir Bandeja» link was 20 px high and
  Territorio actor controls were 28/21 px. An independent synthetic actor seed and explicit actor selection now
  reproduce those failures without suite-order dependence, also exposing two 24 px point-card action links.
  Minimal token-based target-size corrections are under verification; Territorio correction is an early T31
  slice-7 work unit, separate from Inicio's design commit. No failed check is treated as passed.
  Bandeja's worker delivered dense rows/detail and real URL-backed palette filters. Parent reproduced two URL
  defects (removal/restoring the same pendiente and opening with Enter); RED 2 new failures/21 preserved passes,
  then GREEN 23/23. Formatting corrected and typecheck passed. The initial repository gate passed 598 tests before
  this correction; the final-candidate gate and full browsers are separate pending evidence. Pending-item A–E
  data is absent from the API and must not be invented. Unified filter styling and both-theme visual comparison
  remain open. Neither Inicio nor Bandeja is committed or delivered at this checkpoint.
- L17 — Subsequent delivery evidence: #424 merged at da3476b2 (Territorio touch targets, independent synthetic
  actor regression). #425 publishes only the day-summary retry (73 lines, d0f94a9c); its CI/merge wait is still
  pending. Inicio's complete corrected candidate passed 142 browser tests with 3 optional screenshot skips;
  integration with current main and explicit light/dark desktop/phone captures then passed the gate and 11
  focused browser tests. The attention model is committed as 5327ebb6 (113 lines). To keep behavior and tests
  together, the remaining source is split into an approximately 464-line attention/layout unit and a smaller
  composer/status unit; the former's first intermediate gate caught a missing node:path import in the phone
  test, now corrected, with checks pending. The complete verified final files remain preserved locally.
  Bandeja's full corrected candidate passed 143 browser tests/3 optional skips. Shared chip tint first failed
  in both themes; its fix exposed a Registros count-opacity contrast regression (18 passed/1 axe failure).
  Removing that opacity passed the final 19 desktop/mobile/axe probes; theme captures were visually reviewed.
  #426 publishes only the isolated Bandeja layout (203db0e7, 335 lines/4 files, gate/build and 14 browser probes
  passed), with CI pending. A following URL-state work unit on feat/bandeja-url is under isolated verification;
  Ctrl K filters and shared selection styling remain for the next unit. No pending-item A–E data is invented.
  Engram export was executed but withheld from Git: historical observations contain personal references.
  The generated chunk and manifest are preserved in ignored .data/engram-review and the tracked manifest is
  restored to its pre-sync state. This privacy disposition does not erase persistent project memory.
- L18 — Work-unit boundaries applied (no test stripping): #426 merged at e080dafe after head-bound CI.
  Inicio model is isolated at a5f576fd (113 lines, #427, independent of #425; gate passed with 587 web tests),
  attention-first layout at f7c4c436 (465 lines including tests), and honest search/connectivity at 488a8a10
  (296 lines including tests). The 65-line overage of the coherent layout unit is disclosed rather than
  splitting tests from behavior or compressing code; its exact preceding integrated candidate passed the
  gate/build and 9 browser tests/1 optional capture skip. The clean stacked layout and status branches are
  being verified independently without the unrelated summary retry. These branches supersede publishing
  the accumulated feat/design-inicio branch (original commit equivalents 5327ebb6/119b64ab/85749a81).
  A first preparation of the separate Bandeja URL unit accidentally removed the existing Registros context
  spread while excluding later A–E filter work; typecheck caught it before browser tests. The spread is
  restored and typecheck passes; full gate/browser checks remain pending, so no URL unit is published yet.
- L19 — Clean Inicio layout passed its isolated gate/build and 9 browser tests/1 optional capture skip and
  is published as #428, stacked on #427 (must retarget to main only after #427 merges). Bandeja URL unit
  passed gate/build and all 15 desktop/mobile probes including Registros regression coverage; published as
  #429 at 926d3181 (257 lines/4 files). CI is pending. The remaining contextual Ctrl K/filter unit is isolated
  in feat/bandeja-filter-commands, based on the URL unit: 386 diff lines including tests, real URL consumers
  for Bandeja categories and Registros verification filters, and accessible shared selection tint. It is
  being verified independently before commit/publication; original complete source is preserved unchanged.
- L20 — The clean Inicio status/search unit passed its gate/build and all 11 browser probes with explicit
  desktop/mobile light/dark captures; desktop-light and phone-dark images were reviewed. Published as #430
  at 488a8a10, stacked on #428, with the same main-only retarget/CI policy. This does not close T31: #427,
  #428, #429 and #430 still need their applicable CI/merge outcomes; Ctrl K verification is still pending.
- L21 — #425 merged at a1e2e9d7: its watcher hung on a stale IN_PROGRESS frozen-Python check whose job and run
  had both concluded success; merged head-bound to the exact tested head. #427 merged at ce576f8b after CI.
  #428 was retargeted to main by merging main in (no rewrite); that combined head is re-verified before its
  own CI/merge. The Ctrl K/filter unit first ran with a nonexistent accessibility spec path, which Playwright
  silently ignored, so axe had not run; the correct 07-accessibility spec then passed WCAG 2.1 AA in light and
  dark (4/4 with Bandeja). Published as #431 at c731631b (386 lines/12 files), stacked on #429.
- L22 — All seven Inicio/Bandeja units merged after CI on their exact heads: #428 24dc7fe4, #429 7b12915d,
  #430 ffae5863, #431 67508379 (each stacked PR re-verified after merging main in, #430/#431 including axe).
  Next T31 unit, Territorio list ↔ numbered marker and «Sin ubicación», was implemented by a worker on
  feat/territorio-list-map (from 24dc7fe4): RED 4 failures, GREEN geography 85/85 and web 602/602, e2e 8/8 plus
  15 map/3D/hub regressions. ~500 lines, coherent overage disclosed. Limits: no numbers in the Cesium 3D view,
  WebGL numbers only proven to load without errors, the unplaced group ignores toolbar filters, and coordinates
  are not editable outside Sechura (the UI says so). Parent gate, PR, CI and merge pending. T31 stays open.
- L23 — Merged after CI on exact heads: #432 Territorio list ↔ numbered marker and «Sin ubicación» (7c930729);
  #434 two-line phone rows for every Registros type tab, desktop dense table unchanged (0898c398; RED 4, web 617,
  19 browser probes); #433 T32 budgets (b08a8769) and #435 its follow-up (dac70911). T32: accessibility was
  already enforced by 07-accessibility.spec.ts (any WCAG 2.1 A/AA violation, seven destinations, both themes);
  added a bundle budget (today +5%) after the web build and an Inicio usable-time test (6000 ms) on a provisional
  laptop-class profile pending T27. Native review high tier (CI), two lenses, approved with advisories; the
  entry-measures-0 advisory is fixed by #435 (RED 1 → 6/6). First CI timing: Inicio usable in 1691 ms. A
  pre-existing bug (a compromiso opened from the hub as `demandas/<id>`, `?ficha=` lost on reload) is fixed on
  fix/registros-compromiso-ficha (RED 3/2, web 622), PR/CI/merge pending. T32 is done except recalibrating the
  profile and threshold once T27 records the laptop.
