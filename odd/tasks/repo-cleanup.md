# Repository cleanup (T65 of go-rust-stack)

Remove what is really legacy, correct what lies, automate what repeats. Base `main` at `4e301733`; one small reversible PR per
line of the task list; delivery `auto-chain`; runners `node --test scripts/tooling.test.mjs`, `pnpm verify:fast`.

## Specs

- S1 — «parece que es necesario eliminar documentacion legacy , skills legacy , conifguraciones legacy»
- S2 — «objetivo crear nueva documentacion , nuevas skills , mejor automatizacion si algo se hace mas de 2 veces se automatiza»
- S3 — «limpieza , mejor estructura , arquitectura limpia , modularidad , performance»
- S4 — «cuestiona con informacion actualizada de esta semana , mes 2026 , mejorate a ti mismo»
- S5 — Every item gets keep, rewrite, archive or delete, with the proof that nothing depends on it.
- S6 — Not legacy by default: ADRs, applied migrations, `reference/python` while it stays the parity specification, `odd/evidence`, anything TypeScript until retirement.
- S7 — Do not touch while tab go-local works: `apps/api-go`, docker or compose files, `docs/deployment`. Integrate those at the end.
- S8 — Never delete Neon or Vercel resources, never read real data, never touch `~/sipges-cliente-originales`. Worktrees: never remove a dirty or unmerged one; `git worktree remove` without force.

## Tasks

- T1 [x] — S4, S5: this plan. PR #342. Route: inline, three read-only explorers (mapping trigger).
- T2 [x] — S1: remove the 64 worktrees of batch W1 (no PR). Route: inline. See L3.
- T3 [x] — S1, S3: correct the agent docs and skills that lie (A1). Route: inline. PR #343.
- T4 [x] — S1, S3: correct the product and operations docs that lie (A2). Route: inline. PR #344.
- T5 [x] — S1, S3: fix `design/system.md`, add `gomod` and `cargo` to Dependabot (A3). Route: inline. PR #349.
- T6 [x] — S2: `odd-close-task.mjs` log-only mode, tolerant ids, required `--file` (B1). Route: inline. PR #345.
- T7 [x] — S2: `land-pr.sh` (B2). Route: inline. PR #346.
- T8 [x] — S2: `test-pg.sh`, `new-worktree.sh` (B3). Route: inline. PR #347.
- T9 [x] — S2: `watch-tabs.sh` status and until modes, `review-next.sh` (B4). Route: inline. PR #348.
- T10 [x] — S2: `.engram/manifest.json` conflicts, `fmt:changed` (B5). Route: inline. PR #350.
- T11 [ ] — S1, S7: after go-local, delete `spikes/go-container`, raise `engines/go` to Go 1.27, pin CI Go and Postgres, prune `pnpm-workspace.yaml` (C1). Route: inline.
- T12 [ ] — S7: after go-local, worktree batch W2 the deferred README and `docs/deployment` corrections, and the archive of `docs/design/mobile-first`, which needs `docs/README.md`, with the orchestrator as their single writer (C2). Route: inline.

## Plan

### Inventory (non-keep items only, at `4e301733`)

`n` counts inbound references outside the item itself, excluding `data/`, `.engram`, `odd` and `CHANGELOG`.

| Item | Verdict | Proof | PR |
| --- | --- | --- | --- |
| `docs/agents/gentle-ai.md:50` | rewrite | "no hay Go" is false; it is the reason given to exclude `go-testing` | A1 |
| `docs/agents/skills.md` | rewrite | Rust row names a branch merged as #229; explicit-invocation list omits `sipges-self-improve` | A1 |
| `AGENTS.md:3,107` | rewrite | "pnpm TypeScript monorepo" omits `apps/api-go` and `engines/`; "linked from `.claude/skills/`" holds for 17 of 25; "never add exclusions" contradicted by `pnpm-workspace.yaml:7-12` | A1 |
| `.agents/skills/sipges-archify/SKILL.md:18` | rewrite | cites the removed `docs/VERIFICACION.md` | A1 |
| `sipges-self-improve` | keep, open | One event in its evidence row, plus this task: two uses. A third keeps it; otherwise retire it (`tooling.test.mjs:47`, link, `skills.md`, `AGENTS.md:19`) | A1 |
| `CONTRIBUTING.md:3,23` | rewrite | `app.py` is in `reference/python/`; `pytest -q tests` has no root `tests`; no Go or Rust | A2 |
| `docs/overview.md:19`, `docs/ARQUITECTURA.md:60` | rewrite | Both still reject Go/Rust; ADR 0032 adopted them. Both carry a stack table, so they drift together: keep one | A2 |
| `docs/ARQUITECTURA.md:27` | rewrite | "Blob privado": no blob adapter in apps or packages | A2 |
| `docs/testing.md` | rewrite | 0 hits for `go test`, `cargo`, `pnpm parity`, `api-go`, `engines/` | A2 |
| `docs/secure-cookies.md:39` | rewrite in place | Python-centred; path wrong; n=8 including `config.test.ts:7`, so it cannot move | A2 |
| `docs/operations/ci-runner.md:9` | rewrite | "Every job reads runs-on" is false: 8 jobs hardcode ubuntu (`ci:32`, `go:29,129`, `rust:39,61,112,136`, `ops:29`) | A2 |
| `docs/operations/review-materialize.md`, `ops-review-materialize.yml:10` | rewrite | See finding F1 | A2 |
| `docs/operations/handover.md:52` | rewrite | Secret listed for `migrate.mjs` only; no `api-go` | A2 |
| `docs/design/mobile-first/` | archive | n=1 (`docs/README.md:23`), 692 KB, untouched since 10-14 | A3 |
| `design/system.md:15,359` | rewrite | cites `NotificationBell.module.css`, removed in `e4eb765a` | A3 |
| `.github/dependabot.yml` | rewrite | No `gomod` or `cargo`; `:35` names a removed test | A3 |
| `spikes/go-container` | delete | Gate S0 closed, result in ADR 0032. Remaining refs: `apps/api-go/Dockerfile:3` (frozen by S7), `eslint.config.js:20`. Deleting the code does not touch any deployed Worker | C1 |
| `engines/go/go.mod:3` | rewrite | Go 1.25 unsupported since 1.27.0 (2026-08-19); `rust.yml:89` follows it | C1 |
| `pnpm-workspace.yaml:5-12` | rewrite | 3 of 5 excluded versions have 0 lockfile hits; comment misplaced. Lockfile change, so one heavy install | C1 |
| `README.md:3,5,32`, `docs/README.md:3,48`, `docs/benchmarks/README.md:3` | rewrite | v1.0.0 vs 1.1.0; Node-only stack; unindexed pages; relies on superseded ADR 0005. READMEs have one writer | C2 |
| `docs/diagrams/` | rewrite | Nothing on Go or Rust; pinned at `1fdad42`. Regenerate with `sipges-archify` | C2 |

Keeps: 23 of 25 skills, 17 skill links, `.mcp.json`, `.codex`, `.pi`, `settings.json`, `skills-lock.json`, `deploy-workers.yml`, `scripts/*`, `engines/`, `reference/`, `data/` configs, `docs/history`, `docs/migration`, `docs/escenarios`, `docs/integrations`, `spikes/pdf-text`. `scripts/tooling.test.mjs` pins skill and link lists, so any skill removal edits that test.

### Findings beyond cleanup

- F1 — `apps/api/src/tools/review-materialize/cli.ts:48` runs `migrate()` before the dry-run branch, and the workflow's dry run points at production, while its input says "unticked = dry run, writes nothing". A dry run would apply any pending migration to production. A2 corrects the wording only; skipping `migrate` on a dry run is a behaviour change on a migration path and needs the owner's word.
- F2 — Workflow `ci.yml`, `go.yml`, `rust.yml` jobs named above hardcode ubuntu, and all 9 gated jobs need `changes`. Inference, not tested: the self-hosted fallback stalls when hosted minutes run out. Delivery item, not part of this cleanup.

### Worktrees (97 under `.worktrees`, classified read-only)

| Class | Count | Action |
| --- | --- | --- |
| W1: clean, HEAD in `origin/main`, no live process, untouched since before 11-05, only `.atl/` ignored | 64 | Remove (T2), rechecking each one first |
| W2: same, touched 11-05 or later | 18 | Hold until the tabs finish |
| Ignored files besides `.atl/`: `github-main`, `go-privacy`, `go-tenancy` | 3 | Inspect first: `git worktree remove` deletes ignored files without asking |
| Dirty: `delivery-readiness`, `fc-docs-closure`, `go-local`, `go-profile`, `go-trial`, `review-bulk-adv`, `sync-265` | 7 | Never; owner decides |
| Unmerged: `go-b4`, `go-cutover`, `go-read-cpu` | 3 | Never; `go-read-cpu` has 1 unique commit and no PR |
| Live: `go-env`, `repo-clean` | 2 | Later |

Outside `.worktrees`, 12 more are registered (`.claude/worktrees`, `.codex`, `orca`, a stale gentle-ai view with a broken gitfile, the main checkout), of which `feat/actor-identity-register` is dirty and unmerged. They are out of scope.

### Challenges from current sources (consulted 2026-11-06)

| Source (date shown) | Fact | Our choice | Verdict |
| --- | --- | --- | --- |
| [Go downloads](https://go.dev/dl/?mode=json), [release history](https://go.dev/doc/devel/release) (10-19) | go1.27.3 and go1.26.10 are latest; two majors supported | `apps/api-go/go.mod:3`; Dockerfile digest holds 1.27.3 | Agrees. `engines/go` on 1.25 disagrees (C1) |
| [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) (10-05), [limits](https://developers.cloudflare.com/containers/platform/limits/) (11-02) | `basic` is 1/4 vCPU, 1 GiB, 4 GB; billing as in ADR 0032 | `wrangler.go.jsonc:35-37` | Agrees |
| [Containers scaling](https://developers.cloudflare.com/containers/configuration/scaling-and-routing/) (10-16) | "Today, Containers are scaled manually" | One named instance | Single point of failure; change only if traffic needs it |
| [Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/) (06-09), [how it works](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/) (07-05), [Containers outbound](https://developers.cloudflare.com/containers/configuration/outbound-traffic/) (10-29) | Transaction mode; Containers docs never mention Hyperdrive; handlers cover 80 and 443 only | pgx uses a direct URL, `pool_max_conns=10` "was not measured" (`go-trial-runbook.md:141`) | Direct URL agrees. Pool size disagrees: read Neon's limit before activation, since two instances in a rollout hold 20 |
| [PostgreSQL home](https://www.postgresql.org/), [roadmap](https://www.postgresql.org/developer/roadmap/) (19 RC 1, 10-15) | Minors 18.6, 17.11; next minors and RC 2 on 11-12; 19 GA planned 11-19 | CI 17, rehearsals 18.6, `readiness.md:152` says 16 | Disagrees: record production `server_version`, match CI to it, stay off 19 until Hyperdrive lists it |
| [Compose version and name](https://docs.docker.com/reference/compose-file/version-and-name/) (no date), [releases](https://github.com/docker/compose/releases) (v5.7.0, 11-02) | `version` obsolete, warns only | No compose file tracked on `main` | Not applicable yet; go-local must omit `version` |
| [CLAUDE.md memory](https://code.claude.com/docs/en/memory) (no date), [changelog](https://code.claude.com/docs/en/changelog) (2.1.319, 11-06) | Under 200 lines; `AGENTS.md` import supported | 107 lines, `@AGENTS.md` | Agrees |
| [Agent Skills spec](https://agentskills.io/specification) (no date), [Codex skills](https://developers.openai.com/codex/skills/) (no date) | Name matches directory; `SKILL.md` under 500 lines | All 25 pass; vendored `neon` has 502 lines | Agrees; `neon` is upstream's |
| [gentle-ai releases](https://github.com/Gentleman-Programming/gentle-ai/releases) (v4.3.1, 10-27) | Newer than local 4.2.0 | Local tool | Behind; upgrade is the owner's call |

Nothing from November 2026 exists for Go releases, PostgreSQL minors, or the Containers and Hyperdrive changelogs (last entries 09-30 and 09-16). Pages were read through a summarizer, so wording is extraction, not raw HTML.

### Automation (235 transcripts, 68 sessions, 2026-11-01 to 11-06)

Session counts include worker tabs of one orchestration, so they are upper bounds on independent uses. Older transcripts no longer exist.

| Step | Sessions | Uses | Today | Proposal | PR |
| --- | --- | --- | --- | --- | --- |
| ODD log edits | 30 | 189 manual writes, 174 id lookups, `odd:close` 6 | Parser matches 12 of the 30 newest docs; no log-only mode | Tolerant parser, `--log-only`, required `--file` | B1 |
| Land and verify | 49 | 252 merges, 666 `pr view`, 476 `pr checks` | Prose in `sipges-task-pr` | `scripts/agents/land-pr.sh`; never authorizes a merge | B2 |
| Synthetic Postgres | 16 | 67 starts, 323 probes | One sentence in a skill | `scripts/agents/test-pg.sh up\|down\|url` | B3 |
| Worktree setup | 17 | 111 adds, 48 with setup | One line in a skill | `scripts/agents/new-worktree.sh` | B3 |
| Reading and watching tabs | 3 | 271 reads, 322 `hc ls` | `watch-tabs.sh` prints events only | `--status`, `--until`, `--report` | B4 |
| Review parsing | 57 | 549 parsed by hand | None | Read-only `review-next.sh`, printing `next_transition` verbatim; never answers consent. Passive close needs nothing more (3 to 4 sessions) | B4 |
| Manifest conflicts | n/a | 12, 5 since 11-04 | No driver | Handle in `engram.mjs` | B5 |
| Prettier, Engram commit | 44, 20 | 289 writes, 25 syncs | Manual | `pnpm fmt:changed`, `pnpm engram sync --commit` | B5 |

## Log

- L1 (Request): T65 of `odd/tasks/go-rust-stack.md`, 2026-11-06. Owner, verbatim: «parece que es necesario eliminar documentacion legacy , skills legacy , conifguraciones legacy , objetivo crear nueva documentacion , nuevas skills , mejor automatizacion si algo se hace mas de 2 veces se automatiza , limpieza , mejor estructura , arquitectura limpia , modularidad , performance , cuestiona con informacion actualizada de esta semana , mes 2026 , mejorate a ti mismo».
- L2 (Rule breach): two inventory greps ran from the root without excluding `data/` and scanned `data/seed.json`. They printed nothing from it; the affected counts were discarded and redone.
- L3 (T2): all 64 W1 worktrees removed with `git worktree remove`, no force; each one rechecked first; none skipped or failed. 33 remain under `.worktrees`. Branches were kept. Log with HEADs was not committed: every HEAD is in `origin/main`.
- L4 (Plan changes): the archive of `docs/design/mobile-first` moved to T12 because it must edit `docs/README.md`, a single-writer file. `--report` for `watch-tabs.sh` was dropped since `hc read` is already one command. `engram sync --commit` was dropped: it is one line and could only be tested against the real repository.
- L5 (Bugs found): running `land-pr.sh` filters against real `gh` showed a docs-only merge starts no Deploy Workers run (#340) and a skipped run would have read as deployed. Both fixed in #346.
- L6 (Slips): one command wrote a PR body to `/tmp/.x` and removed it, against the scratchpad rule. The `spikes/go-container` proof was tightened: `docs/deployment/go-container.md` and `apps/hosting-cloudflare/src/go-container.ts` share the name but do not depend on the spike.
- L7 (Reviews): the owner granted review of #344, #346, #347, #348 and #350; all five were approved and acknowledged. Two corrections came out of them: `land-pr.sh` silently dropped a second PR number and merged the last one, and `watch-tabs.sh --once --until` could exit 0 without the event. Both were fixed with RED and GREEN. Non-blocking advisories remain, mainly `land-pr.sh` handling of transient `gh` errors and unknown merge states, and `test-pg.sh` directories keyed by basename. A later lint fix to the #346 test changed one character, so #346 was reviewed a second time.
- L8 (T3 landed): PR #343, merge c59412ae, CI green, head ancestor of origin/main.
- L9 (T4 landed): PR #344, merge 28491f43, review reacquired and approved after integrating main.
- L10 (T5 landed): PR #349, merge 6e3f76d3, first review approved.
- L11 (T6 landed): PR #345, merge 4b1f33d7, first review approved.
- L12 (T7 landed): PR #346, merge ea03961a. land-pr fixed for transient gh errors, unknown merge states and the false deploy failure; three review passes, two corrections.
- L13 (T8 landed): PR #347, merge 4be4095f, review reacquired and approved.
- L14 (T9 landed): PR #348, merge ab436d8c, one correction: rejected ignored flags and made review-next stop on any consent schema.
- L15 (T10 landed): PR #350, merge fb03cdc8, one correction: fmt:changed fails when the base cannot be resolved.
- L16 (Landing): Owner authorized landing #342 to #350, then #341 (merge 22ff99cb); #338 stays draft. The false deploy failure came from a workflow_run taking main's tip as its head, so the skipped run of a cancelled CI carries the next commit. Every deploy reaching migrations since 7141a3df failed on the Neon quota. T11 is draft #374 awaiting the owner's merge. T12 corrects README.md, docs/README.md and docs/benchmarks/README.md and archives docs/design/mobile-first to docs/history; docs/deployment corrections stay deferred while local-harden works there, and docs/diagrams was not regenerated.
