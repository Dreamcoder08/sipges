# Agent guide

MASCLI is a pnpm TypeScript monorepo (`apps/api` Hono + PostgreSQL, `apps/web` React/Vite,
`packages/*`). The Python `app.py` is the legacy behavioural specification only. Work is planned
in `odd/tasks/typescript-hexagonal-migration.md`; decisions live in `docs/adr/`.

## Skills (`.claude/skills/`)

| Skill | Use it to |
| --- | --- |
| `mascli-verify` | Run the full gate (`pnpm verify`) with real PostgreSQL when available. |
| `mascli-odd-task` | Pick and close ODD tasks; append log entries with `pnpm odd:close`. |
| `mascli-task-pr` | Commit, push and open a stacked draft PR with the repo conventions. |
| `mascli-benchmark` | Measure processing hotspots against the ADR 0005 gate. |

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm verify` | Lint, format, boundaries, typecheck, all tests; starts local PostgreSQL if installed. |
| `pnpm odd:close -- --task T<n> --label … --text …` | Marks the task done and appends the next `L<n>` entry. |
| `pnpm --filter @mascli/api bench` / `bench:compare` | Runs benchmarks / compares two result files. |
| `pnpm --filter @mascli/api migrate:legacy` | Legacy SQLite → PostgreSQL migration (dry-run by default). |

## Rules

- Synthetic data only in tests, fixtures and benchmarks; never read `data/seed.json` or `data/*.db`.
- No credentials in code or docs; no deployment or real-data migration without the user's word.
- pnpm `minimumReleaseAge` rejects fresh packages: pin older versions, never add exclusions.
