# React Compiler trial (2026-11-19)

**Decision: keep.** React Compiler v1 (stable, Babel) runs in annotation mode on 19 annotated components, 18 of which compile: `TerritorialWorkspace` bails out on its local `select` helper (`[hoisting] EnterSSA`), so it stays uncompiled, which is why Territorio is neutral. It cuts the
components React renders during the measured interactions by 46% on Inicio, 70% on IRSA and 17% on Registros, and
main-thread script time by 26%, 20% and 5%. Territorio is neutral. The entry chunk grows 2.3 kB gzip and stays
inside its budget. Compiling every component (infer mode) renders less but crosses the entry budget, so it was
rejected.

## Setup

`apps/web/vite.config.ts` adds `@rolldown/plugin-babel` with `reactCompilerPreset({ compilationMode: 'annotation' })`
from `@vitejs/plugin-react` 6.2.1, the path its README documents for Vite 8. Only functions that start with
`'use memo'` are compiled ([react.dev: compilationMode](https://react.dev/reference/react-compiler/compilationMode)).

| Package | Version | Published |
| --- | --- | --- |
| `babel-plugin-react-compiler` | 1.0.0 | 2025-10-07 ([React Compiler v1.0](https://react.dev/blog/2025/10/07/react-compiler-1)) |
| `@babel/core` | 7.29.7 | 2026-05-25 (the compiler plugin needs Babel 7 types) |
| `@rolldown/plugin-babel` | 0.3.0 | 2026-10-29 |

All three are older than pnpm's minimum release age; no exclusion was added.

**Why not the Rust compiler.** `@vitejs/plugin-react` also has a native `compiler` option (`oxc-transform-react`,
a Rust port). Its README marks it «experimental», and its peer range (`>=0.152.0 <0.157.0`) pins a fast-moving
package. It produced the same compiled chunks and the same entry size (219.5 kB gzip with the first six
annotations) and built about 1.5 s faster (9.3 s against 10.9 s). The stable compiler won on maturity. Switching
later is a one-line change in `vite.config.ts`.

Annotated components:
- the screens: `InicioPage`; Registros `Workspace` and `TodosList`; `IrsaWorkspace` and `ConfigurationForm`;
  `TerritorialWorkspace`, `MapList`, `OperationsPanel`, `PointCard`, `TerritorialTimeline`;
- the shared pieces the measurement found re-rendering most: `Button`, `Card`, `Field`, `DateText`,
  `DimensionBadge`, `EvidenceTag`, `TypeChip`, `ValidationChip`, `VerificationChip`.

## Method

[`apps/e2e/tests/react-render-cost.spec.ts`](../../apps/e2e/tests/react-render-cost.spec.ts) runs only when
`SIPGES_REACT_TRIAL_OUT` names a JSON-lines file, so the default CI run skips it. It uses the e2e's own synthetic
instance (PGlite), seeds 40 synthetic «Eventos» records, and works on Chromium at 1440×900. The CPU is slowed 4×
and reduced motion is on. Territorio runs on its SVG renderer, which keeps the GPU out of the numbers.

On each screen it waits for the network to settle, then replays a fixed script:

| Screen | Script |
| --- | --- |
| Inicio | types 19 characters in the composer, then clears it |
| Registros › Todos | toggles density four times, opens a row's panel, ArrowDown ×5, Escape |
| IRSA | opens and closes «Cómo se calcula», types 24 characters in «Nota del corte» |
| Territorio | selects six rows of the map list in turn |

What it records:

- **Components rendered** (primary): a minimal DevTools hook that production React DOM calls on every commit. It
  counts function, class and forwardRef components that ran in the commit and skips subtrees React bailed out
  of. The counts are deterministic: identical in every run of a build.
- **Main-thread busy time** (secondary): the change in CDP `ScriptDuration` and `TaskDuration` across the script.
- **Interaction duration**: the longest event-timing entry per `interactionId`, which is the INP measure. Wall-clock
  event timing moved with other load on the machine; see Limits.

The builds alternated (baseline, compiler, baseline, …) for five rounds, on a fresh synthetic instance each run.
The baseline is `origin/main` at `5301f462`.

To reproduce, build each variant, copy it to `apps/web/dist`, then:

```sh
cd apps/e2e
SIPGES_REACT_TRIAL_OUT=/path/to/trial.jsonl SIPGES_REACT_TRIAL_LABEL=compiler \
  pnpm exec playwright test tests/react-render-cost.spec.ts --project=chromium
```

To see component names in `top`, build without minification: `pnpm exec vite build --minify false` in `apps/web`.

## Results

### Components rendered (deterministic)

| Screen | Baseline | Final (19 annotated, 18 compiled) | First pass (6 screen components) | Infer mode, all components (reference) |
| --- | ---: | ---: | ---: | ---: |
| Inicio | 260 | 140 (−46%) | 140 | 80 |
| Registros | 2,033 | 1,691 (−17%) | 2,013 | 1,526 |
| IRSA | 1,440 | 432 (−70%) | 1,440 | 264 |
| Territorio | 1,172 | 1,157 (−1%) | 1,100 | 1,080 |

React commits were the same in every build: 20, 19, 24 and 14. The compiler removes render work inside a commit,
not commits.

Annotating only the six screen components did not help IRSA or Registros. The re-renders were in their children:
`Field` and `FieldErrorText` (504 each on IRSA), `Icon` and the row chips (320–385 each on Registros). Compiling
`ConfigurationForm`, `Field` and the chips brought both close to infer mode.

Territorio stays near baseline in every mode, infer included. `TerritorialTimeline` and the map list give every row
a prop that depends on the selected id, so a selection re-renders all rows. Splitting the row into its own
component is the next step if Territorio needs it.

### Main-thread busy time (5 alternated runs each, ms, CPU 4× slower)

| Screen | Build | Script, median (range) | Task, median (range) | Longest interaction, median (range) |
| --- | --- | ---: | ---: | ---: |
| Inicio | baseline | 143 (120–191) | 451 (424–654) | 40 (40–72) |
| Inicio | compiler | 106, −26% (100–133) | 423 (401–554) | 40 (40–72) |
| Registros | baseline | 237 (223–332) | 1,510 (1,409–1,855) | 184 (152–248) |
| Registros | compiler | 226, −5% (187–249) | 1,379 (1,343–1,549) | 160 (136–176) |
| IRSA | baseline | 244 (225–279) | 899 (836–932) | 56 (40–80) |
| IRSA | compiler | 194, −20% (182–199) | 771 (759–824) | 56 (48–64) |
| Territorio | baseline | 231 (213–259) | 1,729 (1,615–1,824) | 136 (128–152) |
| Territorio | compiler | 220, −5% (209–240) | 1,806 (1,757–1,847) | 152 (136–168) |

Inicio and IRSA improve beyond the run-to-run range. Registros improves on every median, though its ranges overlap.
Territorio's ranges overlap in both directions, so it counts as neutral.

### Bundle (`scripts/check-bundle-budget.mjs`)

| Total | Baseline | Final | Infer mode | Budget |
| --- | ---: | ---: | ---: | ---: |
| Entry, raw | 728.2 kB | 733.0 kB | 775.9 kB | 765 kB |
| Entry, gzip | 217.8 kB | 220.1 kB | 237.1 kB | 229 kB |
| All JavaScript, gzip | 1,998.5 kB | 2,007.4 kB | 2,070.3 kB | 2,080 kB |

## Lint

`eslint-plugin-react-hooks` 7.1.1 `recommended` already enables the compiler-backed rules (`purity`, `refs`,
`immutability`, `set-state-in-effect`, `static-components` and the rest), and `apps/web` passes them. No config
change was needed. With infer mode the compiler skipped about 20 functions: `try`/`finally` blocks, eslint
suppressions of hook rules, and one hook used as a value in `router.tsx`. None of them is on a measured screen, so
none was rewritten.

## Limits

- The first round of 15 runs measured wall-clock event timing while other agents loaded the machine (load average
  6–8 on 12 cores). Every build had runs with 1–2.8 s interactions, so those latencies decide nothing and were
  replaced by main-thread busy time. Busy time still moves with load (Inicio script time ranges 120–191 ms), which
  is why the deterministic render counts are the primary evidence.
- The infer-mode reference numbers came from the native compiler in that first round. Counts are deterministic,
  but they come from a different compiler implementation than the final build.
- Chromium only: CPU throttling and the performance metrics need the DevTools protocol. WebKit runs the functional
  e2e in CI; it could not launch on the trial machine, which lacks its system libraries.

## Render-time dates

The compiler caches a render-time `new Date()` together with the other inputs of the computation that uses it.
Inicio's «this week» line called `eventsThisWeek(events.data, new Date())`, so it stayed on the previous day after
Lima midnight until the events changed. It now reads the day from `useLimaDay()` (`apps/web/src/shared/lib/lima-day.ts`),
which re-renders at Lima midnight; `lima-day.test.tsx` pins this through a component compiled with `'use memo'`.
Avoid `new Date()` during render in compiled components.
