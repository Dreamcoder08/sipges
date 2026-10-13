# Agent guide

MASCLI is a pnpm TypeScript monorepo (`apps/api` Hono + PostgreSQL, `apps/web` React/Vite,
`packages/*`). The Python `reference/python/app.py` is the legacy behavioural specification only. Work is planned
in `odd/tasks/typescript-hexagonal-migration.md`; decisions live in `docs/adr/`.

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

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm verify` | Lint, format, boundaries, typecheck, all tests; PostgreSQL integration only with an explicitly supplied synthetic connection. |
| `pnpm odd:close -- --task T<n> --label … --text …` | Marks the task done and appends the next `L<n>` entry. |
| `pnpm --filter @mascli/api bench` / `bench:compare` | Runs benchmarks / compares two result files. |
| `pnpm --filter @mascli/api migrate:legacy` | Legacy SQLite → PostgreSQL migration (dry-run by default). |

## Rules

- Synthetic data only in tests, fixtures and benchmarks; never read `data/seed.json` or `data/*.db`.
- No credentials in code or docs; no deployment or real-data migration without the user's word.
- pnpm `minimumReleaseAge` rejects fresh packages: pin older versions, never add exclusions.
