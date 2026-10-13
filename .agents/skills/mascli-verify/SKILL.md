---
name: mascli-verify
description: "Trigger: before commit, push or PR, verify, pnpm check, run tests with PostgreSQL. Runs the full MASCLI gate with real PostgreSQL when available."
license: Apache-2.0
metadata:
  author: Dreamcoder08
  version: "1.0"
allowed-tools: Bash(bash scripts/verify.sh*) Bash(pnpm verify*)
---

## Activation Contract

Use before every commit that will be pushed, and after merging a base branch.

## Hard Rules

- Run `pnpm verify` (wraps `scripts/verify.sh`) from the repo root; never push on a non-zero exit.
- The script starts a local PostgreSQL if one is installed and sets `MASCLI_TEST_DATABASE_URL`; never print or commit other database URLs.
- Never skip, disable or quarantine a test to get green.
- Fix formatting with `pnpm format` on changed files only, then re-run.

## Decision Gates

| Output | Action |
| --- | --- |
| `PostgreSQL integration tests enabled` | Real-PG paths covered; report it. |
| `PGlite only` | Say the PostgreSQL tests were skipped. |
| A web `findBy*` timeout only on CI | Check lazy chunks / `asyncUtilTimeout` in `apps/web/src/test/setup.ts`. |

## Execution Steps

1. `pnpm verify`
2. On failure, read the first failing package's output, fix, repeat.

## Output Contract

Report pass/fail, test counts per package and whether PostgreSQL tests ran.

## References

- `scripts/verify.sh`, `package.json` (`check`), `.github/workflows/`
