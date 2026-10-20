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
- T1 [x] S4,F2 — `POST /system/graph/neighbourhood`: several seeds, link types per hop, extra summary fields, read-only for every role; ADR 0022; route: inline; commit: see L2
- T2 [x] S1,S2,S3,F1 — Dossier model: alerts with their originating signals and information state, actions with result, commitments with progress and demands, actors by type, deterministic attention list; route: inline; commit: see L3
- T3 [x] S2,F3 — "Inteligencia operacional" card on `/mapa` following the selection (concession, record, or visible records); `Resultado` field on Acciones; route: inline; commit: see L4
- T4 [x] S5 — API, unit, interface and Chromium E2E coverage; `pnpm verify`; draft PR; route: verify; commit: see L5

## Log
- L1 (plan, 2026-10-19): Read ODD geospatial-timeline, ADR 0011/0017, the ontology service and the map; findings F1-F3 above. PR #63 (MASCLI 4.0) holds ADR 0020 and touches records/modules.ts in another module.
- L2 (T1): POST /system/graph/neighbourhood con semillas múltiples, tipos de vínculo por salto y campos extra; en READ_ONLY_POSTS; consulta no ve restringidos. ADR 0022. Pruebas HTTP de recorrido tipado, 422 por tipo inválido o tres saltos, y rol consulta (b6cf521, PR #66).
- L3 (T2): operations.ts: alertas con señales de origen y estado de información, acciones con resultado, compromisos con avance y demandas, actores por tipo y pendientes deterministas; 6 pruebas unitarias (cdaf809, PR #66).
- L4 (T3): Tarjeta Inteligencia operacional en /mapa que sigue concesión, registro o los 100 visibles más recientes; campo Resultado en Acciones; prueba de interfaz y capturas de escritorio y 390 px con datos sintéticos (cdaf809, PR #66).
- L5 (T4): pnpm verify con PostgreSQL 16 sintético: API 653, web 255, kernel 8, hosting 6; Playwright Chromium 06 CSP, 08 mapa y 20 inteligencia operacional aprobados; PR #66 en borrador, sin despliegue.
