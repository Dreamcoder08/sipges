# Verificación del mapa Archify

Fecha: 2026-10-13. Fuente MASCLI TypeScript: `70d2c40ed6ec7c24c2895889890716168aed4587` (rama de consolidación sobre `main`). Herramienta Archify: `c21c31ffb879668900c5487ea24993bf45d89b15`.

HTML comprobado: `diagrams/arquitectura.html`, SHA-256 `8974bd8941d30bf79eda117fad99fe19c8d8585bbd883aac563e5add567102f1`.

| Comprobación | Resultado |
| --- | --- |
| Validación de fuente, geometría y referencias Git | Pasó |
| Generación del HTML con Archify | Pasó |
| Comprobación estricta de integridad y procedencia | Pasó |
| `browser-check` integrado en `finalize` | Falló: Chromium bloqueó la navegación `file://` con `ERR_BLOCKED_BY_ADMINISTRATOR` |
| Prueba adicional por HTTP local con Playwright/Chromium | Pasó en 1440×900, 1600×1000, 1920×1080, 2048×1320 y 390×844; SVG presente y sin desbordamiento horizontal de la página |
| Interacciones adicionales | Abrir nodo HTTP/Hono mostró tres enlaces al código fijado; cambio de tema y apertura del menú de exportación comprobados |
| JavaScript durante la prueba HTTP | Sin errores de página |
| Verificación del runtime integrado | Web: 99 aprobadas; API SPA: 5 aprobadas; referencia Python: 40 aprobadas. Suite completa y CI se registran en [la consolidación](migration/main-consolidation.md). |
| Inspección visual | Captura de escritorio en tema oscuro revisada; nodos y etiquetas legibles, sin solapamientos visibles |

La captura de escritorio está en [la vista previa](diagrams/arquitectura.png). La prueba HTTP adicional comprueba carga e interacciones básicas; no ejecuta todos los criterios geométricos del `browser-check` de Archify ni prueba los formatos exportados. La comprobación completa de `finalize` queda pendiente en un entorno que permita abrir el archivo local. No se modificaron las políticas del navegador ni el transporte de Archify.

Los recibos detallados de Archify se generan localmente y no se versionan porque contienen rutas de la máquina de ejecución. Consulta [la guía de regeneración](ARQUITECTURA.md) para volver a ejecutar las comprobaciones. La CI de integración usa PostgreSQL real; el resultado final se registra en el informe de consolidación. Se arrancó una instancia temporal Hono/PGlite con cuentas y datos sintéticos para la verificación web; no se modificaron datos reales de usuarios.

T11 completo se comprobó además contra una instancia local temporal de Hono/PGlite con datos sintéticos; consulta [el informe de verificación](migration/t11-verification.md).

Demo pública: despliegue Vercel `dpl_82Q51rFoAhxYALtRchiTDD8pbyC9` READY, conectado al PostgreSQL Neon vinculado por el propietario. Chromium comprobó SPA/login y CSP, `/health` 200 tras migraciones, contraseña válida contra la cuenta persistida, cookie Secure/HttpOnly/SameSite=Strict, sesión tras recargar, vista móvil y logout. Administración devuelve 403 antes de inscribir MFA. Sin errores de página. Quedan pendientes la inscripción del autenticador del propietario y el smoke público de CRUD, Blob y PDF/DOCX; no se presentan como comprobados. CI del código `70d2c40`: PostgreSQL real y 29 pruebas E2E aprobados, ejecución `38477948969`.
