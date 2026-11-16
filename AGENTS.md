# Agent guide

SIPGES is a pnpm monorepo moving to a Go backend, Rust engines and a TypeScript frontend (ADR 0032): `apps/api` Hono +
PostgreSQL, `apps/api-go`, `engines/`, `apps/web` React/Vite, `packages/*`. The Python `reference/python/app.py` is the legacy behavioural specification only. Work is planned
in one feature document per feature under `odd/tasks/` (`pnpm odd:status` lists the open tasks; superseded plans
move to `odd/archive/`); decisions live in `docs/adr/`.

## Skills (`.agents/skills/`; the `sipges-*`, `neon`, `neon-postgres` and `modern-web-guidance` ones are linked from `.claude/skills/`)

| Skill | Use it to |
| --- | --- |
| `sipges-verify` | Run the full gate (`pnpm verify`) with real PostgreSQL when available. |
| `sipges-odd-task` | Pick and close ODD tasks; append log entries with `pnpm odd:close`. |
| `sipges-task-pr` | Commit, push, resume or open a stacked draft PR; land it on main when the merge is authorized. |
| `sipges-archify` | Refresh the TypeScript architecture viewer and pinned ODD evidence. |
| `sipges-sync-main` | Merge `main` into a feature branch and resolve CHANGELOG/ODD log conflicts. |
| `sipges-ci-triage` | Diagnose failing or stuck CI checks: infrastructure rerun vs. code fix. |
| `sipges-phone-check` | Check layouts at 360/412 px with the PGlite e2e and catch overflow. |
| `sipges-self-improve` | Refresh skills, docs and workflows against current official sources, with evidence. |
| `sipges-code-quality` | Review architecture, modularity, patterns, performance and tests against the ADRs. |
| `sipges-go-port` | Port one TypeScript context's read routes to `apps/api-go` with parity cases. |
| `sipges-rust-engine` | Port a pure TypeScript engine to Rust → WebAssembly → Go, byte-identical. |
| `sipges-parallel-agents` | Run units as parallel Herdr tabs; watch, relay prompts, land and close them. |
| `sipges-deps-bump` | Triage, verify, land or hold Dependabot and manual dependency upgrades. |
| `sipges-adr` | Write, number, index and supersede Architecture Decision Records. |
| `sipges-e2e-stabilize` | Write or fix Playwright e2e tests that wait for state, not time. |

Skills require at least three independent uses evidenced in [docs/agents/skills.md](docs/agents/skills.md). Benchmarking has only two archived runs and remains a documented procedure. Load only the matching SKILL.md; repository skills do not grant permissions.

The official `neon` and `neon-postgres` skills are installed at the user's explicit request,
with provenance in `skills-lock.json`. They are vendor instructions, not newly authored
SIPGES workflows. Use them for Neon setup and PostgreSQL connections; installing skills
does not authenticate the CLI or authorize additional services.

The official `modern-web-guidance` skill (GoogleChrome) is installed at the owner's explicit request: use it before
writing HTML, CSS or client JS in `apps/web`. It needs network for its CLI; prefer `pnpx modern-web-guidance@latest …`.

Generic Gentle AI skills (`chained-pr`, `work-unit-commits`, `cognitive-doc-design`, `judgment-day`,
`skill-creator`, `skill-improver`, `typescript`, `zod-4`) are not copied into the repo: they come from the
global `gentle-ai install` (or Gentle Shell), so there is one copy per machine and no shadowing. The repo
keeps only SIPGES-specific skills and the requested Neon and modern-web-guidance ones. Setup in
[docs/agents/gentle-ai.md](docs/agents/gentle-ai.md).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm verify` | Lint, format, boundaries, typecheck, all tests; PostgreSQL integration only with an explicitly supplied synthetic connection. |
| `pnpm verify:fast` | Local inner loop: lint, boundaries and typecheck in parallel, then tests of the packages changed since `origin/main` (and tooling tests when `scripts/` or skills change). CI still runs the full suite. |
| `pnpm parity` | Go/TypeScript parity: same requests to both APIs on one synthetic database, diffs status and JSON ([apps/parity](apps/parity/README.md)). |
| `scripts/agents/watch-tabs.sh` (`--status`, `--until <event>`) | Reports tab state and events; `--until` ends on the first match, for Monitor. |
| `gentle-ai review … --json \| scripts/agents/review-next.sh` | Prints the next transition verbatim; exit 3 on a consent envelope. Never executes it. |
| `scripts/agents/test-pg.sh up` / `url` / `down` | Throwaway loopback PostgreSQL per checkout, for tests and parity. |
| `scripts/agents/new-worktree.sh <name> <branch>` (`--install`) | Creates `.worktrees/<name>` from a fresh `origin/main`. |
| `scripts/agents/land-pr.sh <n>` (`--merge`, `--no-deploy-wait`) | Waits for checks and reports; with `--merge`, which needs authorization, merges, confirms the head is on `origin/main` and waits for Deploy Workers. Exit 7 means unknown, not failed. |
| `deploy/local/test/cli-drill.sh [work folder]` | Clean local install, then `sipgesctl verify` over HTTPS; synthetic data only. |
| `pnpm odd:status` (`--all`, `--json`) | Lists every ODD feature with its open tasks; start here to resume work. |
| `pnpm odd:close -- --task T<n> --label … --text … --file odd/tasks/<feature>.md` | Marks the task done and appends the next `L<n>` entry in the document's style; `--log-only` replaces `--task` to append the entry alone. |
| `pnpm odd:check` | Fails when a feature document repeats a task or log id (CI runs it). |
| `pnpm --filter @sipges/api bench` / `bench:compare` | Runs benchmarks / compares two result files. |
| `pnpm --filter @sipges/api migrate:legacy` | Legacy SQLite → PostgreSQL migration (dry-run by default). |
| `pnpm --filter @sipges/api import:base-maestra -- --seed <file>` | Insert-only load of the prototype's Base Maestra (dry-run by default). |
| `pnpm engram sync` / `import` / `status` | Export, import or compare Engram memory chunks in `.engram/`. |
| `node scripts/agents/engram-manifest-merge.mjs` | During a merge, resolves `.engram/manifest.json` to both sides. |
| `pnpm fmt:changed` | Runs Prettier on the files this branch changed. |

## CLI first

Behaviour is proved through the CLI before any frontend work, and agents verify through it:
`sipgesctl` (`apps/api-go/cmd/sipgesctl`, [docs/agents/sipgesctl.md](docs/agents/sipgesctl.md)) speaks
HTTP to a running API, never to tables, and `sipgesctl verify --synthetic-target` runs the whole
journey. `deploy/local/sipges` stays the script that runs an installation.

For new features the sequence is CLI, then core library (`internal/<context>/{domain,application}`),
then GUI, API or MCP wrappers holding no business logic. Every new route gets an entry in
`apps/api-go/internal/cli/routes.json`; a test fails CI without it.

## Gentle AI and Engram memory

The repo adopts [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) practices; details and local setup
in [docs/agents/gentle-ai.md](docs/agents/gentle-ai.md).

- Engram (`mem_*` tools, MCP server `engram` from `.mcp.json`) is the persistent project memory. Search it
  (`mem_context`, `mem_search`) before asking the user about past work, and `mem_save` decisions, bugfixes,
  conventions and gotchas as they happen (What / Why / Where / Learned, in Spanish, `scope: project`).
- Before the final commit of a task: `mem_session_summary`, then `pnpm engram sync` and commit `.engram/`.
  Chunks are committed, so never save real data, personal data, credentials or private URLs.
- Keep small, understood work inline; delegate to a subagent only for a named reason (wide exploration,
  independent parallel writers, an independent verifier for high-risk changes).
- Test first when a runnable test exists: one failing test per requested rule, then make it pass.

## Proportional work (ODD, TDD, review)

Ceremony scales with risk, not with size. Small, understood work that could be resumed from the request plus
`git diff` runs inline: no feature document, no subagent, no extra review. Only work that fails that resume test
gets an `odd/tasks/<feature>.md`, quoting the user's words as specs.

High-risk items in SIPGES, the only ones that earn an independent verifier (a fresh subagent or `judgment-day`
when the user asks for it) and their own work-unit commit:

- tenant isolation (RLS, `projectId` scoping, exports) and cross-tenant reads;
- identity: sessions, MFA, Google sign-in, API keys, roles and grants;
- database migrations and anything that deletes or rewrites stored records;
- real-data import or migration tools (`import:base-maestra`, `migrate:legacy`) and public exposure (CSP, cookies,
  headers, ingest webhooks).

Pick the review lens by what the change touched, not all of them: readability (naming, structure), reliability
(behaviour, state, tests), resilience (external services, partial failures, degraded providers) and risk
(security, permissions, data exposure or loss).

## Parallel work

Parallel pull requests add files instead of editing shared lists, and shared documents have one writer
(the orchestrator): see [docs/agents/parallel-delivery.md](docs/agents/parallel-delivery.md).

## Rules

- Synthetic data only in tests, fixtures and benchmarks; never read `data/seed.json` or `data/*.db`.
- No credentials in code or docs; no deployment or real-data migration without the user's word.
- pnpm `minimumReleaseAge` rejects fresh packages: pin older versions, never add exclusions.
