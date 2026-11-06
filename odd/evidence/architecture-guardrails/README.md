# Architecture guardrail evidence

Scope: test-only token-policy correction and documentation of existing architectural responsibilities. No production styles, runtime behavior, dependencies, public commands or security policies changed.

## Focused checks

The implementation worker `mvrno17d-5-f7vv` reported these observed runs (attributed handoff, not raw parent-captured stdout/stderr):

- `cd apps/web && node node_modules/vitest/vitest.mjs run src/app/styles/tokens.test.ts --no-fs-module-cache`: RED exit 1, 1 failed / 7 passed. The old substring policy missed four expected offenders.
- Same focused command after the exact-path correction: GREEN exit 0, 8 passed. Existing light/dark consistency and contrast tests remained green.
- `pnpm boundaries`: exit 0; 785 modules, 2,244 dependencies. Includes the existing deliberate-violation fixture and real-tree check.
- Worker `git diff --check`: exit 0 before the parent added the verbatim request to the feature log.

Parent observed:

- `pnpm exec eslint apps/web/src/app/styles/tokens.test.ts`: exit 0.
- `pnpm exec prettier --check apps/web/src/app/styles/tokens.test.ts docs/architecture/architecture-guardrails.md docs/architecture/ui-components.md`: exit 0; all matched files formatted.
- Cited path check: 14 repository paths exist; no missing local guide links.

## Preserved behavior and limits

The exact exceptions are token definitions and the existing `Geography.module.css` and `TerritorialMap.module.css` map palettes. Generic geography controls, similar paths, suffixes and unrelated stylesheets remain subject to the colour guard; semantic token use is accepted. The exceptions still operate at file granularity. They do not certify that every declaration inside those files is map data rather than interface chrome. The colour matcher does not parse all possible CSS syntax.

Import-boundary enforcement already existed. The bounded read-only review did not prove a domain impurity requiring refactoring; it was not an exhaustive ambient-effect audit. Atomic Design is mapped to the responsibilities of real existing components, not enforced by a speculative folder migration.

No global-suite retry: earlier full SIPGES checks timed out and remain failed/incomplete as recorded in `../mature-ui/README.md`. No full web suite, build, browser test, frozen install or new PostgreSQL check was run for this test/documentation-only unit. No CLI parser/shared production helper changed, so a command differential check is not applicable.

Native ASSESS was unavailable because of unrelated untracked scope. Its plan retained writer self-verification, required no independent verifier, and supplied no reviewDue continuation. No native review or approval is claimed. Cloudflare modifications remain excluded from this unit.
