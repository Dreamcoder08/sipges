# MASCLI 4.0 only: verification evidence

Candidate: branch `feat/mascli-4-only` after `3bd65d5`, the working tree of the `feat!` commit
that removes the MASCLI 3.0/4.0 switch ([ODD](../../tasks/mascli-4-only.md), ADR 0027).
Raw `.log`/`.exit` files beside this index are kept locally and ignored by git.

## Results

| Check | Command | Result |
| --- | --- | --- |
| Types | `pnpm typecheck` | exit 0, every workspace |
| Lint and format | `pnpm lint` | exit 0 |
| Architecture boundaries | `node scripts/check-boundaries.mjs` | 737 modules, 2,173 dependencies |
| API | `vitest run --no-fs-module-cache` (apps/api) | 99 files passed, 5 skipped; 694 passed, 14 skipped |
| Web | `vitest run` (apps/web) | 65 files, 282 passed |
| E2E, first run | `pnpm e2e` | 89 passed, 4 failed, 1 skipped (diagnosis below) |
| E2E, final run | `pnpm lint && pnpm e2e` | exit 0: 93 passed, 1 skipped (optional screenshot), 10.6 min |

API went from 696 to 694 tests: the removed tests asserted only MASCLI 3.0 or the toggle.
PostgreSQL-server integration was not run (no authorized synthetic connection); remote CI
did not start because of a GitHub billing block on the account.

## First E2E run: four failures and their causes

| Spec | Cause | Fix |
| --- | --- | --- |
| `13-workflows` desktop and phone | The journey still closed a plan as `Completada` without a file, the MASCLI 3.0 flow that 4.0 refuses | The journey uploads a synthetic receipt through `/system/uploads` (linked to a synthetic event) and selects it; it first asserts that closing without a receipt is blocked |
| `15-record-insights` phone | Real layout bug: level labels now carry their meaning and used `white-space: nowrap`, widening a 390 px page to 475 px | `3bd65d5`: labels wrap |
| `mobile` viewport | Same overflow covered the bottom bar's «Más» button | Same commit |

Two intermediate reruns of the workflow specs failed on test-harness mistakes, not product
behaviour: linking the receipt to an intelligence alert id that the records store does not
hold (404), then reading `id` instead of `attachment.id` from the upload response. Both runs
are retained (`e2e-failed-rerun.*`, `e2e-workflows-rerun.*`); the corrected rerun passed 14/14
(`e2e-workflows-rerun2.*`). No threshold, timeout or assertion was relaxed.

## Review

Independent static review `mvq63n7z-5-5vaj`: no severe issue. It confirmed the two-person rule
is unconditional, a PUT that still sends `version4` is accepted and ignored, a stored key is
neither returned nor re-saved, no migration exists, and stored history (`evidence_url`,
`Origen = 'MASCLI 4.0'`, audit label) is kept. It ran no tests.
