# Conflict-risk prediction

Objective: functional-closure T21 (S12, L10). Branch: `feat/fc-conflict-risk` and its stacked
slices. Delivery: `auto-chain`, stacked to main (domain → API → screen). Test runner: Vitest
(`pnpm --filter @sipges/api test`, `pnpm --filter @sipges/web test`), Playwright for the screen.

## Specs

- S1 — «Predice qué localidades y actores tienen más probabilidad de escalar en 30/90 días, usando demandas, narrativas, alertas e historial de IRSA. Cada predicción muestra en qué se basa y cuán confiable es.»
- S2 — Transparent, explainable model inside the Worker without external AI (no names or personal data leave the system; Ley 29733); ADR in `docs/adr` (0031).
- S3 — Back-test on the project's own history (time split, no leakage), reporting calibration/Brier and the sample size; when history is too thin, say so and show low confidence instead of a number pretending precision.
- S4 — Hexagonal boundaries (ADR 0002): reads other contexts only through ports; tenant-scoped with a cross-tenant test.
- S5 — API endpoint plus a screen inside Análisis, linked from Inicio and the territorial map's Ficha, listing localities and actors ranked by risk with probability band, top contributing factors with links to the source records, confidence and the model's last back-test. Phone layout at 360/412 px.
- S6 — Replace the «no predicción» wording only where this feature now predicts.
- S7 — Tests on synthetic data: rising signals raise risk, no data → «sin datos suficientes», leakage guard in back-test, cross-tenant isolation. CHANGELOG and help text for user-visible changes.

## Tasks

- T1 [x] — S1–S3, S7: ADR 0031 and the pure domain engine (signals, features, score, back-test, calibration, predictions) with unit tests. Route: inline. Commit: PR slice 1 (`feat/fc-conflict-risk`).
- T2 [x] — S4, S5 (API), S7: record reader with `updated_at`, ports wired in `compose.ts`, `GET /system/conflict-risk`, contract, HTTP and cross-tenant tests. Route: inline. Commit: PR slice 2 (`feat/fc-conflict-risk-api`).
- T3 [x] — S5, S6, S7: «Riesgo de conflicto» tab in Análisis, links from Inicio and the map's locality card, phone check, CHANGELOG and help text. Route: inline. Commit: PR slice 3 (`feat/fc-conflict-risk-web`).

## Log

- L1 — 2026-11-02, request (verbatim owner words in S1, scope from functional-closure L10). Delegated to this tab; the parent ticks functional-closure.
- L2 — Map: analytics already reads `module_records` through `AnalyticsRecordReader`; management shows the port pattern for other contexts (`intelligence.allAlerts`, `prevention.list` in `compose.ts`). IRSA is per project (snapshots 0–100), territorial alerts carry `territory`, `level` (Alta/Media/Baja), `status` and `reviewedAt`. Status-as-of-cut-off uses `updated_at`/`reviewedAt` to avoid leakage.
- L3 — T1 done: RED (module missing) then 9/9 domain tests green; analytics folder 59/59 with one worker. Probe on 2,800 synthetic records, 75 units: 0.16 s, 90-day back-test skill 0.70. `pnpm verify:fast`: lint, Prettier, boundaries, typecheck OK; its full API test run was cut off by memory pressure (1.8 GB free), so focused tests stand in locally and CI runs the full suite.
- L4 — T2 done: one RLS-checked query behind both record readers (`createSqlDatedRecordReader` adds `updated_at`), sources wired in `compose.ts` through `intelligence.allAlerts` and `indicators.history`, `GET /system/conflict-risk` and `ConflictRiskResponse`. RED: the HTTP suite fails to load without the route. GREEN: `test/analytics` 64/64 (one worker), including a cross-tenant test with fake per-scope sources, a PGlite RLS test of the dated reader and a full-app test (migrations, session, tenancy middleware; `?project_id=NORTE` refused). Typecheck api/web/contracts, ESLint and boundaries OK.
- L5 — T3 done: «Riesgo de conflicto» tab (`/riesgo`, `?vista=riesgo`, `&localidad=`), links from Inicio's «Riesgo del territorio» card and the map's record Ficha, help section in Ayuda y metodología, CHANGELOG. RED 8 web tests (page, navigation, Inicio, Ficha) then GREEN 56/56 focused; navigation counts moved by the new screen and tab (28→29 screens, Análisis 5→6 tabs). Playwright: new `conflict-risk.mobile.spec.ts` (360/412 px, no page overflow, controls inside the width, axe AA light and dark), `mobile.spec.ts`, `inicio.mobile.spec.ts`, `25-inicio`, `08-territorial-map`: 7 passed. Screenshot review led to three wording fixes (no «proyecto Proyecto», short uncalibrated confidence reason, recency named «Días desde la última señal»). S6: the descriptive engines and the operations panel still do not predict, so their wording stays.
- L6 — Gentle AI review (reliability lens, consent granted by the owner) approved and acknowledged, lineage `review-5cf6d165c0143404`; its four non-blocking findings fixed test-first in slice 3: exact uncalibrated `confidenceReason` asserted over HTTP; the cross-project request asserts 403 «Proyecto fuera de alcance» (was «not 200»); the Ficha hides the risk link when a record has no locality; a new `?localidad=` remounts the risk tab (hub key and `/riesgo` route, like `/inteligencia-redes`). RED observed for the last two. Web 240/240, API analytics 64/64, Playwright 6 passed.
- L7 — Second review (reliability, consent granted) approved and acknowledged, lineage `review-0b535a3c6a66cd19`. Its two non-blocking findings fixed: the recency factor is «días desde la última señal» everywhere (help text, CHANGELOG, ADR table); a test pins that switching horizon changes the band, percentage and back-test card (it passed at once: a coverage pin, not a bug). Web 50/50 in the touched folders, typecheck, ESLint and Prettier OK.
