# Geospatial Analysis with PostGIS

Phase 4 of the territorial-intelligence roadmap the owner proposed after reviewing FireTrace:
proximity and areas of influence. Branch `claude/project-thread-r3z3sk` from `main` 6674b75
(PR #66). Phases 1-3 are in `geospatial-timeline-intelligence.md` and `territorial-operations.md`.

## Specs
- S1: Phase 4 «Análisis geográfico: PostGIS, proximidad, intersecciones, áreas de influencia» (owner, 2026-10-18); "PostGIS para consultar relaciones espaciales reales: si un evento cae dentro de una zona, si dos polígonos se intersectan o qué instalaciones están próximas a un evento".
- S2: Owner's word 2026-10-19: "Continúe". Coordinator brief: separate draft PR with the CI image; do not touch the production Neon database; document the extension step instead.
- S3: Keep Hono, Zod, the hexagonal architecture and shared contracts; no prediction; a written locality never geolocates a record.

## Findings
- F1: The relation (`relations.ts`) already places records inside the polygon by explicit WGS84 coordinates or polygon, or by a documented code reference; there is no distance.
- F2: Production (Neon) and PGlite have no PostGIS; CI used `postgres:17`. Records keep coordinates in their JSON payload, so distances can be computed in a query without new columns or migrations.

## Tasks
- T1 [ ] S1,S3,F1,F2 — `SpatialEngine` port: PostGIS `ST_Distance` on `geography` from the request alone, extension checked every ten minutes, geodesic fallback; `influenceMeters` and `proximity` in the geography contract; ADR 0025; route: inline; commit: pending
- T2 [ ] S1,S3 — Area-of-influence selector on the concession sheet (1/3/5/10 km), distances and measuring engine shown; the operational dossier follows it; route: inline; commit: pending
- T3 [ ] S2 — CI image `postgis/postgis:17-3.5` with an opt-in real PostGIS test; Neon enabling steps in `docs/deployment/territorial-intelligence.md`; `pnpm verify`; draft PR; route: verify; commit: pending

## Log
- L1 (plan, 2026-10-19): Read the geography relation, contract and CI; findings F1-F2 above. Polygon-to-polygon intersections between concessions are left for a concrete need.
