# Fiabilidad de la E2E

## Specs

- S1 (2026-10-19): el titular aprobó, siguiendo las recomendaciones de Gentle AI, arreglar primero la E2E inestable de CSP (`06-csp-screens`, «Network still busy») con ODD y prueba primero.
- S2: la corrección no debilita la prueba: cada pantalla sigue esperando a que su propio documento termine sus peticiones; no se añaden reintentos, esperas fijas ni exclusiones de rutas.

## Findings

- F1: tras mostrar la primera pantalla, `usePreloadScreens` (`apps/web/src/app/router.tsx`) descarga en segundo plano los módulos de todas las pantallas con `requestIdleCallback`.
- F2: cuando la prueba hace `page.goto` a la siguiente pantalla, el documento anterior sigue vivo hasta que llega la respuesta de la navegación. Si en ese hueco se dispara la precarga, sus peticiones empiezan después de la navegación y Chromium las abandona al cambiar de documento, sin evento final. `watchNetwork` solo descartaba las peticiones anteriores a la navegación, así que esas quedaban pendientes para siempre (CI #136, intento 1: exactamente la lista de módulos de pantalla).

## Tasks
- T1 [x] S1,S2 — `watchNetwork` descarta también las peticiones del documento anterior iniciadas entre la petición de navegación y su respuesta; prueba unitaria que falla antes del cambio; route: inline; commit: see L2

## Log
- L1 (plan, 2026-10-19): Leído el log de la CI #136, `support/network.ts`, sus pruebas y la precarga de pantallas; hallazgos F1-F2.
- L2 (T1 espera de red): watchNetwork descarta también las peticiones que el documento anterior inicia entre la petición de navegación y su respuesta (precarga en reposo abandonada por Chromium). Prueba unitaria nueva falló antes del cambio; support/network.test.ts 7/7, typecheck y lint OK. Playwright local con Chromium del contenedor y PGlite: 06-csp-screens 15/15 en 5 repeticiones; mobile, 14-roles y 07-accessibility 6/6 (10499ec).
