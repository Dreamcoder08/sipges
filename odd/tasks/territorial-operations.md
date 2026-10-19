# Territorial Operations Intelligence

Phase 3 of the territorial-intelligence roadmap the owner proposed after reviewing FireTrace:
relate signals, alerts, commitments and territorial actions on the map. Branch
`claude/project-thread-r3z3sk` from `main` 046bb1a (PR #62). Phases 1-2 are in
`geospatial-timeline-intelligence.md`.

## Specs
- S1: Phase 3 «Inteligencia operacional: relacionar señales, alertas, compromisos y acciones territoriales» (owner, 2026-10-18).
- S2: Selecting a concession must answer: "¿Qué comunidades, instituciones y compromisos están relacionados? ¿Qué señales justifican una alerta? ¿Qué acciones se realizaron y qué resultados tuvieron?"
- S3: "Cada evento debe conservar su fuente, fecha, localización y grado de verificación"; Observado / Estimado / Escenario hipotético; no prediction, no spreading.
- S4: Keep Hono, Zod, the hexagonal architecture, shared contracts and TanStack Query; the map engine stays an adapter.
- S5: Owner's word 2026-10-19: "Te autorizo todo y avanza de forma autónoma". No production deploy (coordinator brief).

## Findings
- F1: Typed links exist (ADR 0011): `origina` (evento/narrativa/demanda → alerta), `atiende` (acción → alerta, inferred from `Alerta_Asociada`), `responde_a` (compromiso/acción → demanda, inferred from `Demanda_Asociada`), `participa_en`, `plantea`, `difunde`, `sustenta`.
- F2: `GET /system/graph` starts from one record and follows every link type; two hops from an event reach every other record of its actor.
- F3: Acciones have no result field; Compromisos have `Avance_%`, `Fecha_Vencimiento` and `Evidencia_Cierre`.

## Tasks
- T1 [ ] S4,F2 — `POST /system/graph/neighbourhood`: several seeds, link types per hop, extra summary fields, read-only for every role; ADR 0021; route: inline; commit: pending
- T2 [ ] S1,S2,S3,F1 — Dossier model: alerts with their originating signals and information state, actions with result, commitments with progress and demands, actors by type, deterministic attention list; route: inline; commit: pending
- T3 [ ] S2,F3 — "Inteligencia operacional" card on `/mapa` following the selection (concession, record, or visible records); `Resultado` field on Acciones; route: inline; commit: pending
- T4 [ ] S5 — API, unit, interface and Chromium E2E coverage; `pnpm verify`; draft PR; route: verify; commit: pending

## Log
- L1 (plan, 2026-10-19): Read ODD geospatial-timeline, ADR 0011/0017, the ontology service and the map; findings F1-F3 above. PR #63 (MASCLI 4.0) holds ADR 0020 and touches records/modules.ts in another module.
