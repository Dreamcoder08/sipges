# Verificación del mapa Archify

Fecha: 2026-10-13. Fuente MASCLI: `c442ebf23fc11f612746d53a11f2f3b470790fa0`. Herramienta Archify: `c21c31ffb879668900c5487ea24993bf45d89b15`.

HTML comprobado: `diagrams/arquitectura.html`, SHA-256 `163621ca16e4cc98d8b834dc47fe96d2b3c0845124431f870e24b7435400f779`.

| Comprobación | Resultado |
| --- | --- |
| Validación de fuente, geometría y referencias Git | Pasó |
| Generación del HTML con Archify | Pasó |
| Comprobación estricta de integridad y procedencia | Pasó |
| `browser-check` integrado en `finalize` | Falló: Chromium bloqueó la navegación `file://` con `ERR_BLOCKED_BY_ADMINISTRATOR` |
| Prueba adicional por HTTP local con Playwright/Chromium | Pasó en 1440×900, 1600×1000, 1920×1080, 2048×1320 y 390×844; SVG presente y sin desbordamiento horizontal de la página |
| Interacciones adicionales | Abrir nodo FastAPI mostró tres enlaces al código fijado; cambio de tema y apertura del menú de exportación comprobados |
| JavaScript durante la prueba HTTP | Sin errores de página |
| Inspección visual | Captura de escritorio en tema oscuro revisada; nodos y etiquetas legibles, sin solapamientos visibles |

La captura de escritorio está en [la vista previa](diagrams/arquitectura.png). La prueba HTTP adicional comprueba carga e interacciones básicas; no ejecuta todos los criterios geométricos del `browser-check` de Archify ni prueba los formatos exportados. La comprobación completa de `finalize` queda pendiente en un entorno que permita abrir el archivo local. No se modificaron las políticas del navegador ni el transporte de Archify.

Los recibos detallados de Archify se generan localmente y no se versionan porque contienen rutas de la máquina de ejecución. Consulta [la guía de regeneración](ARQUITECTURA.md) para volver a ejecutar las comprobaciones. Las pruebas se limitaron a la documentación: no se arrancó MASCLI ni se modificaron bases de datos o archivos de usuarios.
