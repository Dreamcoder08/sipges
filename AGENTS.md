# Agent guide

MASCLI is a pnpm TypeScript monorepo (`apps/api` Hono + PostgreSQL, `apps/web` React/Vite,
`packages/*`). The Python `reference/python/app.py` is the legacy behavioural specification only. Work is planned
in one feature document per feature under `odd/tasks/` (`pnpm odd:status` lists the open tasks; superseded plans
move to `odd/archive/`); decisions live in `docs/adr/`.

## Skills de Codex (`.agents/skills/`)

| Skill | Use it to |
| --- | --- |
| `mascli-verify` | Run the full gate (`pnpm verify`) with real PostgreSQL when available. |
| `mascli-odd-task` | Pick and close ODD tasks; append log entries with `pnpm odd:close`. |
| `mascli-task-pr` | Commit, push and resume or open a stacked draft PR with the repo conventions. |
| `mascli-archify` | Refresh the TypeScript architecture viewer and pinned ODD evidence. |

Skills require at least three independent uses evidenced in [docs/agents/skills.md](docs/agents/skills.md). Benchmarking has only two archived runs and remains a documented procedure. Load only the matching SKILL.md; repository skills do not grant permissions.

The official `neon` and `neon-postgres` skills are installed at the user's explicit request,
with provenance in `skills-lock.json`. They are vendor instructions, not newly authored
MASCLI workflows. Use them for Neon setup and PostgreSQL connections; installing skills
does not authenticate the CLI or authorize additional services.

Gentle AI skills, vendored at the user's explicit request (provenance in `skills-lock.json`,
details in [docs/agents/gentle-ai.md](docs/agents/gentle-ai.md)):

| Skill | Use it to |
| --- | --- |
| `chained-pr` | Split changes over ~400 lines into stacked, reviewable PRs. |
| `work-unit-commits` | Plan commits as reviewable work units with their tests and docs. |
| `cognitive-doc-design` | Write docs, ADRs and guides that are quick to review. |
| `judgment-day` | Run a blind dual adversarial review, only when explicitly asked. |
| `skill-creator` / `skill-improver` | Create or audit skills (still subject to the 3-use rule). |
| `typescript` / `zod-4` | TypeScript strict patterns and Zod 4 API changes. |

Commands in these skills that call the `gentle-ai` binary (review capture, skill-registry) apply only where
it is installed locally; the repo does not require it.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm verify` | Lint, format, boundaries, typecheck, all tests; PostgreSQL integration only with an explicitly supplied synthetic connection. |
| `pnpm odd:status` (`--all`, `--json`) | Lists every ODD feature with its open tasks; start here to resume work. |
| `pnpm odd:close -- --task T<n> --label … --text …` | Marks the task done and appends the next `L<n>` entry. |
| `pnpm --filter @mascli/api bench` / `bench:compare` | Runs benchmarks / compares two result files. |
| `pnpm --filter @mascli/api migrate:legacy` | Legacy SQLite → PostgreSQL migration (dry-run by default). |
| `pnpm --filter @mascli/api import:base-maestra -- --seed <file>` | Insert-only load of the prototype's Base Maestra (dry-run by default). |
| `pnpm engram sync` / `import` / `status` | Export, import or compare Engram memory chunks in `.engram/`. |

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

High-risk items in MASCLI, the only ones that earn an independent verifier (a fresh subagent or `judgment-day`
when the user asks for it) and their own work-unit commit:

- tenant isolation (RLS, `projectId` scoping, exports) and cross-tenant reads;
- identity: sessions, MFA, Google sign-in, API keys, roles and grants;
- database migrations and anything that deletes or rewrites stored records;
- real-data import or migration tools (`import:base-maestra`, `migrate:legacy`) and public exposure (CSP, cookies,
  headers, ingest webhooks).

Pick the review lens by what the change touched, not all of them: readability (naming, structure), reliability
(behaviour, state, tests), resilience (external services, partial failures, degraded providers) and risk
(security, permissions, data exposure or loss).

## Rules

- Synthetic data only in tests, fixtures and benchmarks; never read `data/seed.json` or `data/*.db`.
- No credentials in code or docs; no deployment or real-data migration without the user's word.
- pnpm `minimumReleaseAge` rejects fresh packages: pin older versions, never add exclusions.
