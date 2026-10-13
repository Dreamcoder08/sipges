---
name: mascli-odd-task
description: "Trigger: continue ODD, close task, T<n> done, update ODD log. Picks the next ODD task and closes it with a log entry via script."
license: Apache-2.0
metadata:
  author: Dreamcoder08
  version: "1.0"
allowed-tools: Bash(node scripts/odd-close-task.mjs*) Bash(pnpm odd:close*)
---

## Activation Contract

Use when the user says "continúa con ODD" or a task in `odd/tasks/*.md` is finished.

## Hard Rules

- The plan is `odd/tasks/typescript-hexagonal-migration.md`; specs S1–S8 are the user's words, never edit them.
- Close a task only after `mascli-verify` passes and its PR exists.
- Never edit log numbers by hand; use the script, which appends `L<max+1>` after the highest entry.
- Log entries state evidence: what changed, tests run, review findings, what stays pending. No real data, no credentials.

## Decision Gates

| Situation | Action |
| --- | --- |
| Next task unclear | First `- T<n> [ ]` in the Tasks list. |
| Task too big for one PR | Split into `T<n>a..` sub-bullets first, close each. |
| User decision needed (domain, credits, deploy) | Record it as pending; do not decide. |

## Execution Steps

1. `pnpm odd:close -- --task T<n> --label "T<n> <topic>" --text @/path/entry.txt --dry-run`
2. Re-run without `--dry-run`; commit with the task's changes.

## Output Contract

Report the task closed, the new `L<n>` and what remains open.

## References

- `scripts/odd-close-task.mjs`, `docs/migration/`, `docs/adr/`
