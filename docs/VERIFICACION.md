# Verificación del mapa Archify

Fecha: 2026-10-13. Fuente MASCLI TypeScript: `f9db457d4151d18898163dffb78c653cd859e0a6` (rama `feat/typescript-migration-11b-records-ui`). Herramienta Archify: `c21c31ffb879668900c5487ea24993bf45d89b15`.

HTML comprobado: `diagrams/arquitectura.html`, SHA-256 `356eb1670ad14fbaa3d9fb72e38221d081a07a5c3afb53110eab6565bfc3fbb9`.

| Comprobación | Resultado |
| --- | --- |
| Validación de fuente, geometría y referencias Git | Pasó |
| Generación del HTML con Archify | Pasó |
| Comprobación estricta de integridad y procedencia | Pasó |
| `browser-check` integrado en `finalize` | Falló: Chromium bloqueó la navegación `file://` con `ERR_BLOCKED_BY_ADMINISTRATOR` |
| Prueba adicional por HTTP local con Playwright/Chromium | Pasó en 1440×900, 1600×1000, 1920×1080, 2048×1320 y 390×844; SVG presente y sin desbordamiento horizontal de la página |
| Interacciones adicionales | Abrir nodo HTTP/Hono mostró tres enlaces al código fijado; cambio de tema y apertura del menú de exportación comprobados |
| JavaScript durante la prueba HTTP | Sin errores de página |
| `corepack pnpm check` | Pasó: lint, límites de dependencia, tipos y tests (API: 382 pasaron / 6 omitidos; web: 46; kernel: 3) |
| Inspección visual | Captura de escritorio en tema oscuro revisada; nodos y etiquetas legibles, sin solapamientos visibles |

La captura de escritorio está en [la vista previa](diagrams/arquitectura.png). La prueba HTTP adicional comprueba carga e interacciones básicas; no ejecuta todos los criterios geométricos del `browser-check` de Archify ni prueba los formatos exportados. La comprobación completa de `finalize` queda pendiente en un entorno que permita abrir el archivo local. No se modificaron las políticas del navegador ni el transporte de Archify.

Los recibos detallados de Archify se generan localmente y no se versionan porque contienen rutas de la máquina de ejecución. Consulta [la guía de regeneración](ARQUITECTURA.md) para volver a ejecutar las comprobaciones. La revisión de documentación se complementó con `pnpm check` sobre el workspace TypeScript. Las seis pruebas omitidas son de integración opcional con PostgreSQL real; no se configuró su conexión. No se arrancó un servidor persistente ni se modificaron bases de datos o archivos de usuarios.

La funcionalidad T11b se comprobó además contra una instancia local temporal de Hono/PGlite con datos sintéticos; consulta [su informe de verificación](migration/t11b-verification.md).
