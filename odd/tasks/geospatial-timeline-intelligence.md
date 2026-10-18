# Geospatial and Timeline Intelligence

Phases 1 and 2 of the territorial-intelligence roadmap the owner proposed after reviewing
FireTrace: a geospatial engine with selectable INGEMMET concessions, and an evolution timeline
synchronised with the map. Branch `claude/project-thread-lpyzms` from `main` 72e8096 (PR #54).

## Specs
- S1: "No la copiaría literalmente… la utilizaría como inspiración para evolucionar tu software hacia una plataforma de inteligencia geoespacial, análisis temporal y apoyo a decisiones" (owner, 2026-10-18). Keep Hono, Zod, the hexagonal architecture, shared contracts and TanStack Query; no Redux, Tailwind, shadcn or FastAPI.
- S2: Phase 1 «Motor geoespacial»: MapLibre GL JS + deck.gl as an adapter inside MASCLI, vector layers, INGEMMET queries returning structured geometry and attributes (code, holder, status), selectable concessions with a contextual sheet.
- S3: Phase 2 «Tiempo y evidencias»: timeline synchronised with the map, filters and historical traceability.
- S4: "un conflicto social no se comporta como el fuego": no spreading stains, no prediction. Three information states, Observado / Estimado / Escenario hipotético; every record keeps source, date, location and verification grade.
- S5: Fluid map on desktop; on phones a clean map with swipeable contextual sheets, not FireTrace's controls squeezed into 400 px.
- S6: Real project data only; no demo records. Phases 3-6 (operational intelligence, PostGIS, CesiumJS 3D, sensors) are out of scope here.

## Findings
- F1: `/mapa` drew SVG markers over raster tiles; the cadastre was only an ArcGIS `export` image, so concessions could not be selected.
- F2: The API already proxies INGEMMET (`POST /system/geography/query`, fixed hosts, size and time limits) and relates MASCLI records by explicit WGS84 coordinates or a documented `Concesion_Codigo` + `Concesion_Fuente`; it returns Esri JSON rings.
- F3: SERV_CATASTRO_MINERO layer 0 publishes CODIGOU, CONCESION, TIT_CONCES, HECTAGIS, ESTADO, D_ESTADO, LEYENDA, FEC_DENU, FECHA_ACTUALIZACION, DISTRI/PROVI/DEPA (checked 2026-10-18 on the layer's REST metadata).
- F4: Records carry `Nivel_Verificacion` (A Confirmada … E No verificada) and `Fuente_ID`; nothing marks a scenario.
- F5: The SPA CSP blocks `eval` and only allows images from the tile hosts; MapLibre fetches tiles and spawns workers.

## Tasks
- T1 [x] S2,S5 — ADR 0017: MapLibre GL JS 6 + deck.gl 9 in a lazy chunk, same-origin module worker, CSP `connect-src`/`img-src blob:`, SVG renderer kept as fallback; route: inline; commit:
- T2 [x] S2 — `engine/GeoCanvas`: raster basemaps, districts, concessions (GeoJsonLayer) and records (ScatterplotLayer) with picking, zoom and home controls, keyboard pan/zoom; route: inline; commit:
- T3 [x] S2,F2,F3 — Concessions of the current view (≤ 2.5°, 200 per query) from INGEMMET via the existing API; Esri rings → GeoJSON; contextual sheet with official attributes, source and the records related by geometry or documented code; "solo vinculados" filter; route: inline; commit:
- T4 [x] S4,F4 — Information state per record (`evidence.ts`): declared `Estado_Informacion` (new optional event field) or Observado only with grade A–C and a source; scenarios never inferred; shown with its basis, on the map, list, sheet and CSV; route: inline; commit:
- T5 [x] S3 — Evolution timeline synchronised with the map: period histogram, month-by-month playback of what was documented (no projection), list that selects and frames records, state filters; route: inline; commit:
- T6 [x] S5 — Phone sheet above the tab bar: peeks, expands and closes by swipe or tap; selecting from the list brings the map back into view; route: inline; commit:
- T7 [x] S6 — Unit, interface and Chromium E2E coverage; `pnpm verify`; merge and public deploy check; route: verify; commit:

## Log
- L1 (plan, 2026-10-18): Read the current map, cadastre layer, geography API and CSP; findings F1-F5 above.
