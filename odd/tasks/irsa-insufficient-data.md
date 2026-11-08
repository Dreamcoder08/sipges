# IRSA with insufficient data

An empty project shows IRSA 5.55 "Verde – Situación estable / riesgo bajo" because dimensions
without any evidence score 0. In an early-warning system "no data" must never read as "low risk".

## Specs

- S1 — Owner context: on a fresh local instance the Inicio briefing showed «IRSA 5.5 Verde – Situación estable / riesgo bajo» with no records; `GET /system/irsa` returned `{"irsa":5.55,"level":"Verde","scores":{"G":0,"A":0,"D":0,"N":0,"E":0,"I":33.33}}`. The owner authorised the fix: «perfect te autorizo todo y avanza mi objetivo es estar en la vanguardia».
- S2 — Additive API, no contract break: `GET /system/irsa` keeps every existing field and value (`irsa`, `level`, `scores`, `weights`, `thresholds`, `drivers`, …) and adds `coverage: { "G": n, "A": n, "D": n, "N": n, "E": n, "I": n }` (number of stored inputs that fed each dimension in the computation, 0 when none) and `insufficient_data: boolean`, true exactly when the five evidence dimensions G, A, D, N and E all have coverage 0. Dimension I (institutional/traceability) does not count as evidence for this rule.
- S3 — Web: wherever the IRSA level/colour is shown (Inicio briefing «Riesgo del territorio», Dashboard, Análisis IRSA), when `insufficient_data` is true show the neutral text «Sin datos suficientes» with no risk colour and no level label, plus the line «Carga registros del proyecto para calcular el IRSA.». When the IRSA config `status` is `PENDIENTE_DE_VALIDACION_METODOLOGICA`, show the badge «Metodología pendiente de validación» next to the IRSA value in those same places.
- S4 — Go parity: `apps/api-go` returns the same two fields with the same values for the same data; parity fixtures/goldens are regenerated with the repository's own generator, not hand-edited.
- S5 — Nothing stored changes: no migration, IRSA history rows and automation/alert rules that read `level` behave exactly as before.

## Tasks

- T1 — S2, S4, S5: API field in TypeScript and Go with tests (empty project → insufficient; one record in one evidence dimension → not insufficient; I-only data → insufficient), parity fixtures. Route: gentle-ai-worker (TS) + gentle-ai-worker (Rust engine). Done: engine and API commits of this branch (L4).
- T2 — S3: web rendering with tests. Route: same worker after T1. Done: web commit of this branch (L4).
- T3 — S1–S5: independent verification (Risk item 3: response consumed by web, Go parity and automations). Route: gentle-ai-verify. Done: L4 verdict. Commit: n/a.

## Log

- L1 — Owner request (2026-11-07): «perfect te autorizo todo y avanza mi objetivo es estar en la vanguardia», answering the proposal to fix «El IRSA dice "riesgo bajo" sin tener datos».
- L2 — Design choice (parent): additive fields instead of a new `level` value, so existing consumers of `level` (web, automation domain, management overview, Go parity) do not break.
- L3 — Workers' evidence: Rust engine emits the fields (5 RED→GREEN tests, 41 shared fixtures byte-identical to TypeScript); indicators.wasm rebuilt by the parent with the reproducible flags of engines/build-wasm.sh, after proving the same command on origin/main reproduces the committed wasm hash (afcfdba7…). TypeScript domain/HTTP and web done; Go goldens regenerated with generate.mjs. Decision: with `insufficient_data` the web also hides the numeric IRSA value, since a number misleads as much as a colour (extends S3). Follow-up: the pending-badge text is duplicated in dashboard/IrsaStatus.tsx and indicators/IrsaPage.tsx (features cannot import each other); move to shared/ui later.
- L4 — T3 verdict (gentle-ai-verify): S1–S5 met, no blocker. The verifier rebuilt indicators.wasm reproducibly to the committed hash (58dd49e3…); fixtures and goldens are byte-identical to origin/main once the two new keys are removed; TS and Rust outputs byte-identical on every reachable input; the stricter engine validation (missing `dimensions`, non-numeric evidence_count) is unreachable from real paths (Go sends records only, TS builds the report in-process); the web reads status from /system/irsa/config (PENDIENTE_DE_VALIDACION_METODOLOGICA in both backends). Parent added the verifier's three regression tests (directory-only insufficient, unscored indicators ignored, key order): test/indicators 27/27. Full checks before: API 143 files/1093 passed/32 skipped, web 517, Go indicators/engines/management/automation ok, cargo test + fmt, both fixture generators --check. Owner-facing follow-up (methodology, not a defect): one record in any evidence dimension (even a single event with only a description, via A4) ends `insufficient_data`, so «5.55 Verde» returns; a minimum-evidence threshold is a methodology decision for the owner.
