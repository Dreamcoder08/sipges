# Territorial 3D View

Phase 5 of the territorial-intelligence roadmap the owner proposed after reviewing FireTrace:
a 3D view of the territory. Branch `claude/project-thread-r3z3sk-3d`, stacked on PR #71
(phase 4, `geospatial-analysis.md`).

## Specs
- S1: Phase 5 «Vista 3D» (owner, 2026-10-18), with CesiumJS named for later; MapLibre + deck.gl first.
- S2: Owner's word 2026-10-20: "Te autorizo todo de forma autónoma y avanza". Coordinator brief: draft PR, no production changes, no paid services.
- S4: Owner's word 2026-10-20: "Continua parece que cesiumjs tiene versión opensource": use CesiumJS (Apache 2.0) for the terrain.
- S3: No prediction or spreading; keep the Observado / Estimado / Escenario states; authorised, verifiable data only.

## Findings
- F1: The WebGL map (ADR 0017) already uses MapLibre with a deck.gl overlay; pitch, rotation and `ColumnLayer` need no new dependency.
- F2: Good CesiumJS terrain needs Cesium ion (token, paid tiers). Deck.gl overlay layers do not drape on MapLibre terrain, so points would drift off their real position on slopes.
- F3: Headless Chromium runs WebGL 2, so the 3D toggle can be tested end to end.
- F5: `@cesium/engine` runs without Cesium ion: `CustomHeightmapTerrainProvider` reads Terrarium tiles; three spots (a style attribute, the credit <style>, meshoptimizer's eager WebAssembly) break the strict CSP and are patched at build time.
- F4: MapLibre `hillshade` over open Terrarium elevation tiles (AWS Open Data, no key) shows relief without raising the ground.

## Tasks
- T1 [x] S1,S3,F1,F2,F4 — «Vista 3D» toggle: tilted, rotatable camera; hillshade relief; documented records as columns per ~1.1 km cell with a count-based height; scenarios excluded; ADR 0026; route: inline; commit: see L2
- T2 [x] S2,F3 — Unit tests for the columns, Chromium end-to-end test, `pnpm verify`, draft PR; route: verify; commit: see L3

- T3 [x] S4,S3,F5 — CesiumJS terrain view replacing the MapLibre tilt: real relief, basemap draped, records and concessions clamped, record columns, height tint without basemap; Cesium served from /cesium/ under the CSP; ADR 0026 rewritten; route: verify; commit: see L4

## Log
- L1 (plan, 2026-10-20): Read the WebGL engine and the territorial page; findings F1-F3 above. Raised terrain and CesiumJS are deferred until something must be measured on the relief (basins, slopes); relief is shaded only.
- L2 (T1): Botón Vista 3D (aria-pressed) que inclina y deja girar el mapa WebGL; columnas por celda de 0,01° con altura proporcional al número de registros documentados (8 px por registro), sin escenarios; relieve sombreado con Terrain Tiles abiertas, CSP con s3.amazonaws.com; ADR 0026 (2b07568, 7e53394).
- L3 (T2): Pruebas unitarias de columnas y estilo; prueba Chromium 21-territorial-3d; pnpm verify con PostgreSQL 16 + PostGIS: API 658, web 262, kernel 8, hosting 6; Chromium 06, 08, 14, 20 y 21 aprobados; PR en borrador apilado sobre #71.
- L4 (T3): Vista 3D con CesiumJS (@cesium/engine 26.3.0, Apache 2.0, sin Cesium ion): relieve real de Terrain Tiles decodificado en el navegador, mapa base drapeado o tinte por altura, registros y concesiones sobre el terreno, columnas de 400 m por registro; /cesium/ servido con la CSP de la app; parches de compilación para estilos en línea y meshoptimizer; ADR 0026 reescrito. pnpm verify: API 659, web 262, kernel 8, hosting 6; Chromium 06, 08, 14, 18, 20 y 21 y móvil (22) aprobados (86b4ad0).
