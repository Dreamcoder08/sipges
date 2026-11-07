---
name: sipges-parallel-agents
description: "Use when SIPGES work splits into independent units to run in parallel as Claude Code tabs in Herdr, or to watch, relay prompts for, land and close tabs already launched. The orchestrator assigns every task."
---

# Orchestrate parallel agents in Herdr

The general Herdr mechanics (`herdr-app do tab.new`, `hc ls`, `hc read`) are in the user-level
`herdr-parallel-agents` skill; this one adds the SIPGES rules.

## Launch

1. Split only units with disjoint edit surfaces. Units that need the same file run in series in one tab.
   The orchestrator assigns each unit its task ID (`T<n>` of a feature document); a worker never picks one.
2. One worktree and branch per unit, from `origin/main`:
   `scripts/agents/new-worktree.sh <name> <branch>` (`--install` when the unit needs Node dependencies).
3. Each tab prompt stands alone, in English: what to read first (`AGENTS.md`, the feature document
   until `## Log`, the skill to apply), the exclusive worktree, the owner's words verbatim, scope and
   what not to touch, checks, delivery and report. It ends with this block, unchanged:

   ```text
   Rules: synthetic data only; never read data/seed.json or data/*.db. No credentials or private URLs in
   code, docs or commits. Pin dependencies older than pnpm's minimumReleaseAge; never add exclusions.
   Conventional commits, no AI attribution or co-author trailers. Memory limits: VITEST_MAX_WORKERS=2,
   go test -p 2, cargo -j 2. Do not edit shared documents (feature document Tasks/Log, READMEs of
   other units): put your Log entry in the PR description. If a Gentle AI review consent prompt
   appears, stop and wait for the owner; never answer it. When done, do not pick another task.
   ```

4. Synthetic PostgreSQL for tests and parity: `scripts/agents/test-pg.sh up` prints the URL of a
   local server whose superuser is `sipges_test`; `down` removes it. The URL has this form,
   without a query string, e.g. `postgres://sipges_test@127.0.0.1:55439/sipges_test`. Never a real
   database.

## Watch

Run `scripts/agents/watch-tabs.sh` (or `--once`) beside the tabs. It prints `BLOCKED`, `CONSENT`,
`DONE` and `MERGED` lines and changes nothing. `--status` shows every tab; `--until <event>` ends on
the first match, which suits Monitor.

- `BLOCKED` / `CONSENT`: read the tab (`hc read <tab> --lines 60`) and relay the prompt to the owner
  losslessly: every option, label and description, in order. Never answer it yourself; send the
  owner's exact answer with `hc send <tab> <answer>`.
- `DONE`: read the report, check the PR, then close the tab (`hc kill <tab>`) to free memory.
- `MERGED`: tell the tabs whose PRs overlap that file set to merge `origin/main` (`sipges-sync-main`).

## Land

Merge one PR at a time (`sipges-task-pr`, land step): after each merge, the next PR merges
`origin/main` again and waits for green CI. Then the orchestrator alone records each unit's Log entry
and task close in the feature document (spec S6 of `odd/tasks/conflict-free-delivery.md`).

## Report

Per tab: unit, PR, checks, merged or pending, and prompts still waiting on the owner.

Reference: [Codex skills](https://developers.openai.com/codex/skills/).
