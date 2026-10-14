# Ontology and Intelligence Platform

Close the gap between MASCLI and state-of-the-art analysis platforms (Palantir-style ontology, link analysis, search, provenance, AI assistance) on top of the TypeScript monorepo on `main`. Branch `claude/project-thread-yqrjlu` from `main` 86aba17. Synthetic data only; no deployment, real-data migration or paid service activation without the user's word.

## Specs
- S1: "que el falta para que tenga la calidad de palantir y otros software de vanguardia??"
- S2: "Yes crea ODD e implementa todo eso y mas" — accepted gap list (2026-10-14): typed ontology with links, link analysis and 360° view, global search, record history, LLM assistant, finer permissions, ingestion, observability, analytical map; recommended order 1 → 2 → 3 → 4 first.
- S3: Keep the existing guarantees: hexagonal contexts, forced RLS per tenant, append-only audit, MFA, existing HTTP contract (ADR 0007) and parity tests stay green.

## Tasks
- T1 [ ] S2,S3 — ADR 0011 ontology, links and provenance; this ODD; route: inline; commit: pending
- T2 [ ] S2,S3 — Record version history: append-only `record_versions` written by trigger with actor, `GET /api/{module}/{id}/history`, diff timeline in the record detail; route: inline; commit: pending
- T3 [ ] S2,S3 — Ontology catalog (object and link types) and typed links: `record_links` with cascade, inferred reference links, `/system/ontology`, `/system/links`, links panel in the record detail; route: inline; commit: pending
- T4 [ ] S2 — Global full-text search (generated `tsvector`, GIN, prefix matching, ranking) `GET /system/search` and a Ctrl+K command palette; route: inline; commit: pending
- T5 [ ] S2 — Entity 360° and link analysis: `GET /system/graph` (n-hop neighbourhood) and an explorer page with an interactive force graph; route: inline; commit: pending
- T6 [ ] S2,S3 — Observability: request ids, structured JSON logs, `Server-Timing`, admin `/system/metrics` (Prometheus text); route: inline; commit: pending
- T7 [ ] S2,S3 — Classification markings per record (público, interno, restringido) enforced in SQL for the consulta role; route: inline + review; commit: pending
- T8 [ ] S2 — Ingestion: CSV import per module with column mapping, dry-run, batch provenance in history; route: inline; commit: pending
- T9 [ ] S2 — AI analyst: language-model port (Anthropic adapter when configured, deterministic extractive fallback) producing entity briefings with record citations; route: inline; commit: pending
- T10 [ ] S2 — Analytical timeline and map: cross-module chronology and time filter on the territorial map; route: inline; commit: pending
- T11 [ ] S2,S3 — Export allowlist, E2E coverage, docs and architecture viewer refresh; route: verify; commit: pending

## Log
- L1 (plan, 2026-10-14): Gap review in the project thread found every record stored as an untyped `payload jsonb` in `module_records`, no links, no full-text index, history lost on `UPDATE`, lexical-only classifier, four URL-prefix roles and console-only logging. The user asked to create this ODD and implement all of it and more.
