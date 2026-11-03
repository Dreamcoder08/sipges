# Parallel delivery without merge conflicts

Several agents port contexts and engines at the same time, one branch and one pull request each.
These rules keep those pull requests from conflicting with each other.

## One file per entry

A pull request adds files; it does not edit a list that another pull request also edits.

| What you add | Where it goes | Shared file you do not edit |
| --- | --- | --- |
| A Go context's routes | `apps/api-go/internal/app/context_<name>.go`, calling `registerContext` from `init` | `internal/app/app.go` |
| A context's parity cases | `apps/parity/src/contexts/<name>.ts`, exporting `cases` and `seed` | `apps/parity/src/contexts/index.ts` |

## One writer for shared documents

The feature document (`odd/tasks/<feature>.md`), `CHANGELOG.md`, READMEs and ADRs have one writer: the orchestrator.
Tests that check every context is wired derive the expected names from the `context_*` files, so a new context
edits no test list either.

- The orchestrator assigns task ids (`T<n>`) before launching a worker and writes the task line.
- A worker writes its log entry (and any changelog line) in the pull request description, under `## Log entry`.
- After the merge, the orchestrator appends that entry to the feature document with `pnpm odd:close`.

## Merging main

- Merge `origin/main` into the branch locally, never rebase a pushed branch.
- `.gitattributes` gives append-only logs (`odd/tasks/*.md`, `CHANGELOG.md`) git's `union` driver, so a local merge keeps both sides. GitHub ignores merge drivers on pull requests: its "Update branch" button and conflict check still report a conflict, which a local merge resolves.
- `pnpm odd:check` (run in CI) fails when a union merge leaves a repeated task or log id.

## Landing

- Land pull requests one at a time: merge the green one first, then merge `main` into the next.
- GitHub's merge queue would automate this, but it requires an organization-owned repository; this one belongs to a personal account.

## Sources

- [GitHub merge queue availability](https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/)
- [GitHub ignores `merge=union` on pull requests](https://github.com/orgs/community/discussions/9288)
- [Git attributes: built-in `union` merge driver](https://git-scm.com/docs/gitattributes#_built_in_merge_drivers)
