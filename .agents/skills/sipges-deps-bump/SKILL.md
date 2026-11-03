---
name: sipges-deps-bump
description: "Use when SIPGES Dependabot PRs are open, a dependency must be upgraded, held back or pinned, or pnpm refuses a version as too new. Does not authorize merging."
---

# Triage and land dependency updates

Configuration: `.github/dependabot.yml` (npm and GitHub Actions, monthly, groups `react` and
`dev-tooling`, `ignore` holds with their reason) and `pnpm-workspace.yaml` (`minimumReleaseAgeExclude`).

## Per Dependabot PR

1. **Read the change.** `gh pr view <n> --json title,body,files`; open the release notes it links. Mark
   it **major** (or `0.x` minor) when the version jump can break: read the breaking changes and grep their
   APIs (`git grep -n '<api>'`). Examples: `postgres` 3 → 4 (#148), `@anthropic-ai/sdk` 0.x → 1 (#78).
2. **Group rules.** `react` and `react-dom` (and their types) move together: React refuses to run when they
   differ by a patch (#140, #145). A dev-tooling group PR that touches many packages is verified as one.
3. **Verify on the PR branch.** `gh pr checkout <n>`, `pnpm install --frozen-lockfile`, then
   `sipges-verify` (`pnpm verify:fast` for a patch, the full gate for a major or a runtime package).
   A browser package (`maplibre-gl`, `@deck.gl/*`, `@radix-ui/*`) also needs `pnpm e2e` on the affected
   screens (`sipges-e2e-stabilize`).
4. **Decide:**

| Outcome | Action |
| --- | --- |
| Green, no API change | Land with `sipges-task-pr` (land step), one PR at a time; Dependabot rebases the rest. |
| Breaks, fix is small | Commit the adaptation on the PR branch (`fix(<scope>): …` beside the bump). |
| Breaks, fix is not ours | Hold: pin the last good version, add an `ignore` entry with its reason and the condition to drop it (as `@playwright/test` 1.64.x, `fb325da`), close the PR with that reason. |

## Manual upgrades and pnpm's release age

pnpm's `minimumReleaseAge` refuses versions published too recently. Pin the newest version older
than the window; never add a `minimumReleaseAgeExclude` entry. Existing entries are legacy: remove one once
its version is old enough or no longer resolved (`pnpm why <pkg>`).

Dependabot's own `cooldown` (version updates only, 3 days by default; keys `default-days`,
`semver-major-days`, `semver-minor-days`, `semver-patch-days`, `include`, `exclude`; GitHub docs, read
2026-11-03) keeps its PRs past that window. Security updates ignore `cooldown`: when pnpm refuses one, pin
the newest allowed patch and record the follow-up.

## Checks and report

Commits follow Conventional Commits (`build(deps): …`, `chore(deps): …`), no AI attribution. Report per
PR: version jump, risk (patch/minor/major), checks, decision (landed, adapted, held with reason).

Reference: [Codex skills](https://developers.openai.com/codex/skills/),
[Dependabot options](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference).
