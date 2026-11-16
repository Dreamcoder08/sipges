# CI budgets

Three checks in [`ci.yml`](../../.github/workflows/ci.yml) fail the build when the web app crosses a budget
(closure-roadmap T32).

| Budget | Where it runs | What fails it |
| --- | --- | --- |
| Accessibility | `e2e` job, Chromium shards: [`07-accessibility.spec.ts`](../../apps/e2e/tests/07-accessibility.spec.ts) | Any axe WCAG 2.2 A/AA violation (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`: `WCAG_22_AA` in [`accessibility.ts`](../../apps/e2e/support/accessibility.ts)), of any impact, on sign-in, every screen and the five hubs (Inicio, Registros, Territorio, Bandeja, Análisis; Integraciones and Configuración are screens), in light and dark. |
| Bundle size | `static` job, after the web build: [`check-bundle-budget.mjs`](../../scripts/check-bundle-budget.mjs) | A total in `BUDGETS` grows past its limit: the entry loaded by `index.html` (raw and gzip), all JavaScript (gzip) or all CSS (gzip) under `apps/web/dist/assets`. |
| Inicio usable time | `e2e` job, Chromium shards: [`inicio-performance.spec.ts`](../../apps/e2e/tests/inicio-performance.spec.ts) | The median of `COLD_LOADS` (3) cold loads of `/inicio`, each until «Necesita tu atención» is visible and the composer is enabled, exceeds `INICIO_USABLE_BUDGET_MS`. All three times are logged. |

Run them locally:

```sh
pnpm --filter @sipges/web build && node scripts/check-bundle-budget.mjs
pnpm --filter @sipges/e2e exec playwright test tests/inicio-performance.spec.ts tests/07-accessibility.spec.ts --project=chromium
```

## Bundle budgets

Set on 2026-11-12 from the build of `origin/main` at `ffae5863`, plus 5% headroom:

| Total | Measured | Budget |
| --- | ---: | ---: |
| Entry, raw | 688.8 kB | 724 kB |
| Entry, gzip | 206.7 kB | 218 kB |
| All JavaScript, gzip | 1,980.0 kB | 2,080 kB |
| All CSS, gzip | 44.3 kB | 47 kB |

Raw totals then were 7,271.8 kB of JavaScript and 223.7 kB of CSS. Vite already warns that three chunks
(`index`, `GeoCanvas`, `CesiumCanvas`) exceed 500 kB; the budget records that size and does not fix it.
`dist/cesium/` is copied static data and is not counted.

To change a budget, edit `BUDGETS` in the script on purpose, in the pull request that grows or shrinks the
bundle, with the new measurement in the comment above it. Lower it when a change makes the bundle smaller.

## Inicio usable time — provisional profile

The roadmap asks for the laptop-class profile recorded in T27. **T27 is not recorded yet**, so the spec uses a
provisional profile that is a plausible stand-in, not a measurement of the laptop: Chromium with its CPU
slowed 4× (DevTools `Emulation.setCPUThrottlingRate`), 40 ms latency, 10 Mbit/s down and 5 Mbit/s up, an
empty HTTP cache, signed in to the synthetic project.

The spec loads `/inicio` cold three times in one test (`COLD_LOADS`), logs every time and holds the
**median** to the budget, so one noisy load neither fails nor hides a regression.

The budget is **3,000 ms**, set on 2026-11-13 from runs of the spec alone on a 12-core development machine
that was also running a desktop session, ten runs per row (five for 12 cores), three loads each:

| Cores | Medians seen | Worst median | Slowest single load |
| --- | ---: | ---: | ---: |
| 12 (unpinned) | 1,153–1,639 ms | 1,639 ms | 1,696 ms |
| 2 (`taskset -c 0,1`) | 1,329–2,184 ms | 2,184 ms | 2,695 ms |
| 1 (`taskset -c 0`) | 1,996–3,247 ms | 3,247 ms | 5,447 ms |

The `e2e` job runs on `ubuntu-latest`, whose smallest GitHub-hosted shape has two cores; 3,000 ms leaves 1.4×
over the worst two-core median. A threefold regression of the fastest median (1,153 ms → 3.5 s) fails it; the old
6,000 ms budget let a regression of more than 3× pass. CI measured 1,691 ms for one load before this change.
**One core is not covered**: one of ten pinned runs had a median of 3,247 ms and would fail, so a runner
with a single core, or one heavily shared, needs a new measurement before this budget is trusted there.
CPU throttling is relative to the host, so a slower runner measures more.

The check was shown to fail by lowering the budget to 500 ms (median 1,660 ms of 1,986, 1,399 and
1,660 ms: failed) and to pass again at 3,000 ms (median 1,678 ms).

When T27 is recorded, replace `PROFILE` and `INICIO_USABLE_BUDGET_MS` (and, if needed, `COLD_LOADS`) at the top
of the spec with the laptop's figures and update this section.
