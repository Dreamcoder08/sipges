# CI budgets

Three checks in [`ci.yml`](../../.github/workflows/ci.yml) fail the build when the web app crosses a budget
(closure-roadmap T32).

| Budget | Where it runs | What fails it |
| --- | --- | --- |
| Accessibility | `e2e` job, Chromium shards: [`07-accessibility.spec.ts`](../../apps/e2e/tests/07-accessibility.spec.ts) | Any axe WCAG 2.1 A/AA violation, of any impact, on sign-in, every screen and the five hubs (Inicio, Registros, Territorio, Bandeja, Análisis; Integraciones and Configuración are screens), in light and dark. |
| Bundle size | `static` job, after the web build: [`check-bundle-budget.mjs`](../../scripts/check-bundle-budget.mjs) | A total in `BUDGETS` grows past its limit: the entry loaded by `index.html` (raw and gzip), all JavaScript (gzip) or all CSS (gzip) under `apps/web/dist/assets`. |
| Inicio usable time | `e2e` job, Chromium shards: [`inicio-performance.spec.ts`](../../apps/e2e/tests/inicio-performance.spec.ts) | A cold load of `/inicio` takes longer than `INICIO_USABLE_BUDGET_MS` until «Necesita tu atención» is visible and the composer is enabled. |

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

The budget is 6,000 ms. Local runs on 2026-11-12 (12-core development machine) measured 1,243–1,624 ms, and
1,793–2,413 ms when the whole suite was pinned to one or two cores. CPU throttling is relative to the host,
so a slower CI runner measures more.

When T27 is recorded, replace `PROFILE` and `INICIO_USABLE_BUDGET_MS` at the top of the spec with the
laptop's figures and update this section.
