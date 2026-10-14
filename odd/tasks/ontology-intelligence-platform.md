# Ontology and Intelligence Platform

Close the gap between MASCLI and state-of-the-art analysis platforms (Palantir-style ontology, link analysis, search, provenance, AI assistance) on top of the TypeScript monorepo on `main`. Branch `claude/project-thread-yqrjlu` from `main` 86aba17. Synthetic data only; no deployment, real-data migration or paid service activation without the user's word.

## Specs
- S1: "que el falta para que tenga la calidad de palantir y otros software de vanguardia??"
- S2: "Yes crea ODD e implementa todo eso y mas" — accepted gap list (2026-10-14): typed ontology with links, link analysis and 360° view, global search, record history, LLM assistant, finer permissions, ingestion, observability, analytical map; recommended order 1 → 2 → 3 → 4 first.
- S3: Keep the existing guarantees: hexagonal contexts, forced RLS per tenant, append-only audit, MFA, existing HTTP contract (ADR 0007) and parity tests stay green.

## Tasks
- T1 [x] S2,S3 — ADR 0011 ontology, links and provenance; this ODD; route: inline; commit: see L2
- T2 [x] S2,S3 — Record version history: append-only `record_versions` written by trigger with actor, `GET /api/{module}/{id}/history`, diff timeline in the record detail; route: inline; commit: see L3
- T3 [x] S2,S3 — Ontology catalog (object and link types) and typed links: `record_links` with cascade, inferred reference links, `/system/ontology`, `/system/links`, links panel in the record detail; route: inline; commit: see L4
- T4 [x] S2 — Global full-text search (generated `tsvector`, GIN, prefix matching, ranking) `GET /system/search` and a Ctrl+K command palette; route: inline; commit: see L5
- T5 [x] S2 — Entity 360° and link analysis: `GET /system/graph` (n-hop neighbourhood) and an explorer page with an interactive force graph; route: inline; commit: see L6
- T6 [x] S2,S3 — Observability: request ids, structured JSON logs, `Server-Timing`, admin `/system/metrics` (Prometheus text); route: inline; commit: see L7
- T7 [x] S2,S3 — Classification markings per record (público, interno, restringido) enforced in SQL for the consulta role; route: inline + review; commit: see L8
- T8 [x] S2 — Ingestion: CSV import per module with column mapping, dry-run, batch provenance in history; route: inline; commit: see L9
- T9 [x] S2 — AI analyst: language-model port (Anthropic adapter when configured, deterministic extractive fallback) producing entity briefings with record citations; route: inline; commit: see L10
- T10 [x] S2 — Analytical timeline and map: cross-module chronology and time filter on the territorial map; route: inline; commit: see L11
- T11 [x] S2,S3 — Export allowlist, E2E coverage, docs and architecture viewer refresh; route: verify; commit: see L12

## Log
- L1 (plan, 2026-10-14): Gap review in the project thread found every record stored as an untyped `payload jsonb` in `module_records`, no links, no full-text index, history lost on `UPDATE`, lexical-only classifier, four URL-prefix roles and console-only logging. The user asked to create this ODD and implement all of it and more.
- L2 (T1 ODD y ADR): ADR 0011 y este ODD se publicaron con el historial (21eec62); ADR 0012 y 0013 se añadieron con sus tareas.
- L3 (T2 historial): record_versions append-only por trigger SECURITY DEFINER con actor, GET /api/{module}/{id}/history y panel de diffs (21eec62).
- L4 (T3 ontología): Catálogo de 14 tipos y 12 tipos de vínculo, record_links con cascada, vínculos inferidos y vista 360° (8588066).
- L5 (T4 búsqueda): Índice GIN de expresión con configuración simple sin acentos, coincidencia por prefijo e id exacto, paleta Ctrl+K (de65280).
- L6 (T5 grafo): GET /system/graph acotado a 2 saltos y 150 nodos; grafo de fuerzas determinista en la vista 360° (ede8ff6).
- L7 (T6 observabilidad): X-Request-Id, logs JSON, Server-Timing y /system/metrics Prometheus solo para administración (ebc7293, f7f3bcf).
- L8 (T7 clasificación): Marcas público/interno/restringido; mascli_can_see() en RLS oculta restringidos, su historial, vínculos y búsqueda al rol consulta (a5ce9c6).
- L9 (T8 importación): Importación CSV con mapeo de columnas, vista previa y fusión todo-o-nada auditada; hasta 2000 filas (99d96a6, 9496089).
- L10 (T9 analista): Informe extractivo con citas numeradas y Narrator opcional con Claude; nunca envía restringidos, valida citas y cae al extractivo ante fallos. ADR 0013 (e5edf22).
- L11 (T10 cronología): GET /system/timeline, pantalla Cronología con histograma mensual y filtro Desde/Hasta en el mapa territorial (097b0b2).
- L12 (T11 verificación): Exportación incluye record_versions y record_links; E2E de 360°, informe, búsqueda y cronología; suite E2E completa 32/32; mapa Archify con todas las puertas (4929042, 34a70d9).
