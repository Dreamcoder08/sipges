---
name: mascli-task-pr
description: "Trigger: open PR, ship task, stacked branch, draft PR for T<n>. Branch, commit, push and open a stacked draft PR with MASCLI conventions."
license: Apache-2.0
metadata:
  author: Dreamcoder08
  version: "1.0"
disable-model-invocation: false
---

## Activation Contract

Use when an ODD task (or sub-task) is ready to publish.

## Hard Rules

- Branch `feat/typescript-migration-<nn>-<topic>` from the previous task's branch; base the PR on it (stacked). Never push to another branch.
- Commit author: `Dreamcoder08 <132953839+Dreamcoder08@users.noreply.github.com>`; Conventional Commits; end with the session's attribution trailers.
- Separate commits for unrelated fixes found on the way (e.g. `fix(db): …` before `feat(api): …`).
- PR is a draft, body in Spanish from `assets/pr-body.md`; assign Dreamcoder08; subscribe to its activity.
- Never merge, force-push someone else's branch, or deploy without the user's word.

## Decision Gates

| Situation | Action |
| --- | --- |
| Base PR merged | Retarget to its base, merge base into head (no rebase). |
| CI red | Root-cause; fix and push; never re-run blindly. |
| Diff > ~1500 lines | Split into sub-task PRs. |

## Execution Steps

1. `mascli-verify` passes.
2. `git -c user.name=Dreamcoder08 -c user.email=132953839+Dreamcoder08@users.noreply.github.com commit`
3. `git push -u origin <branch>`
4. Create draft PR (GitHub MCP), assign, subscribe.
5. Close the ODD task with `mascli-odd-task` if not already in the diff.

## Output Contract

PR URL, base branch, CI state, what the user must decide.

## References

- `assets/pr-body.md`, `.github/workflows/`
