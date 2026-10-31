# Verificación del mapa Archify

## Inteligencia territorial y ejecución por eventos (2026-10-17)

Fuente fijada: `1fdad42f65f977a7fad85e2e26ee65f7b26c48d1`, revisión publicada que contiene todos los archivos/rangos enlazados. El mapa representa esa instantánea; los cambios posteriores conservan sus propios commits. Herramienta Archify: `c21c31ffb879668900c5487ea24993bf45d89b15`, obtenida del archivo oficial de GitHub para ese commit después de interrumpir una clonación sin progreso. No se añadió como dependencia de MASCLI.

HTML generado: `diagrams/arquitectura.html`, SHA-256 `b80eccba2224c0d5caf2ad2f867c53feb6f9376a4e1c384fd8cbd9e6f9bda996` (859833 bytes). Fuente JSON: SHA-256 `5f98c37c0afa112a6c84a4b5bf02d60f5125a2d3ca4ec9e5c81971d7190c7ba7`.

| Comprobación | Resultado |
| --- | --- |
| `finalize architecture --quality showcase`: fuente, geometría y referencias Git | Pasó en el candidato 2; el primero detectó y permitió corregir un rango fuera de la revisión fijada |
| Generación del HTML (`deliver`) | Pasó; bytes generados y licencia conservados |
| Integridad/procedencia (`check`) | Pasó |
| `browser-check` integrado con `/usr/bin/chromium` | Falló: `Chrome navigation failed: net::ERR_BLOCKED_BY_ADMINISTRATOR` al abrir `file://` |
| Prueba independiente por HTTP local | Pasó en Chromium/Playwright a 1600×1100 y 390×844; SVG presente, sin desbordamiento horizontal ni errores de página |
| Referencias e interacciones HTTP | Nodo Geografía mostró tres enlaces Git con el commit fijado; cambio a tema oscuro y apertura del menú SVG/PNG comprobados |
| Inspección visual | Captura [arquitectura.png](../diagrams/arquitectura.png) revisada: 16 nodos, etiquetas y tarjetas legibles, sin solapamientos visibles |

Los recibos frescos permanecen en `/tmp/mascli-archify-territorial-review-1` y `/tmp/mascli-archify-territorial-review-2`; la comprobación HTTP produjo `/tmp/mascli-archify-http-review.json` dentro del contenedor de navegador. Son evidencia local y contienen rutas efímeras, por lo que no se versionan. Un primer intento de interacción HTTP agotó su selector; se corrigió el selector al identificador del nodo y la prueba siguiente pasó. No se modificó la política del navegador. La prueba HTTP no sustituye el gate geométrico integrado, que permanece fallido, ni comprueba los formatos exportados.

Se documentaron geography/system, los destinos fijos INGEMMET/Defensoría, señales pendientes de verificación humana, ejecución por `waitUntil` y respaldo cron diario autenticado a las 04:15 UTC. No se presenta la evaluación por reglas como IA de pago, ni se garantiza latencia o recepción humana. La verificación en vivo de GEOCATMIN sigue pendiente por errores TLS/503; el diagrama no acredita disponibilidad de proveedores ni recepción en un teléfono real. Esta entrega no ejecutó el gate completo de MASCLI ni redesplegó producción; el cierre de su ODD registra esas comprobaciones por separado.

La demo actual permite contraseña sin inscripción obligatoria con `MASCLI_REQUIRE_MFA=0`, por petición del propietario; conserva TOTP voluntario y el valor predeterminado de MASCLI exige MFA. Los párrafos históricos siguientes describen las configuraciones y revisiones de sus fechas.

## Automatización e integración (2026-10-14)

Fuente: `4673f4bd842cc960192ba1450349ea49e89288e0` (rama `claude/project-thread-67pd9u`). Herramienta Archify: `c21c31ffb879668900c5487ea24993bf45d89b15`. HTML: `diagrams/arquitectura.html`, SHA-256 `c037c1073fb65932c9fee7173342945d04dc6248c766962cdf7a638a9f2d49c1`.

| Comprobación | Resultado |
| --- | --- |
| Validación de fuente, geometría y referencias Git | Pasó (tras dejar tres fuentes por componente, el máximo del esquema) |
| Generación del HTML con Archify | Pasó |
| Comprobación estricta de integridad y procedencia | Pasó |
| `browser-check` integrado en `finalize` | Pasó con el Chromium de Playwright (`ARCHIFY_CHROME`) |

Se añadieron los nodos de agentes e integraciones (MCP, webhooks entrantes) y de canales de salida. No se comprobaron los formatos exportados ni se redesplegó la demo pública.

## Plataforma de ontología (2026-10-14)

Fuente: `49290423d4ea2de329b0b09924916cd2e9a588ac` (rama `claude/project-thread-yqrjlu`). Herramienta Archify: `c21c31ffb879668900c5487ea24993bf45d89b15`. HTML: `diagrams/arquitectura.html`, SHA-256 `c1d14a8969bc1d99b8eec0951d2c7db4adf5ea1c32b99b7cdfd6d48171969a1c`.

| Comprobación | Resultado |
| --- | --- |
| Validación de fuente, geometría y referencias Git | Pasó (tras acortar dos etiquetas a 48 caracteres) |
| Generación del HTML con Archify | Pasó |
| Comprobación estricta de integridad y procedencia | Pasó |
| `browser-check` integrado en `finalize` | Pasó con el Chromium de Playwright (`ARCHIFY_CHROME`) |
| Prueba adicional por HTTP local | 1440×1217 y 390×844 en tema oscuro, sin desbordamiento horizontal ni errores de página |
| Inspección visual | Captura de escritorio revisada: diez nodos, el externo Claude marcado como opcional, etiquetas legibles |

No se comprobaron los formatos exportados. La demo pública no se redesplegó con estos cambios.

## Consolidación sobre `main` (2026-10-13)

Fuente MASCLI TypeScript: `70d2c40ed6ec7c24c2895889890716168aed4587` (rama de consolidación sobre `main`). Herramienta Archify: `c21c31ffb879668900c5487ea24993bf45d89b15`.

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
| Verificación del runtime integrado | Web: 99 aprobadas; API SPA: 5 aprobadas; referencia Python: 40 aprobadas. Suite completa y CI se registran en [la consolidación](main-consolidation.md). |
| Inspección visual | Captura de escritorio en tema oscuro revisada; nodos y etiquetas legibles, sin solapamientos visibles |

La captura de escritorio está en [la vista previa](../diagrams/arquitectura.png). La prueba HTTP adicional comprueba carga e interacciones básicas; no ejecuta todos los criterios geométricos del `browser-check` de Archify ni prueba los formatos exportados. La comprobación completa de `finalize` queda pendiente en un entorno que permita abrir el archivo local. No se modificaron las políticas del navegador ni el transporte de Archify.

Los recibos detallados de Archify se generan localmente y no se versionan porque contienen rutas de la máquina de ejecución. Consulta [la guía de regeneración](../ARQUITECTURA.md) para volver a ejecutar las comprobaciones. La CI de integración usa PostgreSQL real; el resultado final se registra en el informe de consolidación. Se arrancó una instancia temporal Hono/PGlite con cuentas y datos sintéticos para la verificación web; no se modificaron datos reales de usuarios.

T11 completo se comprobó además contra una instancia local temporal de Hono/PGlite con datos sintéticos; consulta [el informe de verificación](t11-verification.md).

Demo pública: despliegue Vercel `dpl_82Q51rFoAhxYALtRchiTDD8pbyC9` READY, conectado al PostgreSQL Neon vinculado por el propietario. Chromium comprobó SPA/login y CSP, `/health` 200 tras migraciones, contraseña válida contra la cuenta persistida, cookie Secure/HttpOnly/SameSite=Strict, sesión tras recargar, vista móvil y logout. Administración devuelve 403 antes de inscribir MFA. Sin errores de página. Quedan pendientes la inscripción del autenticador del propietario y el smoke público de CRUD, Blob y PDF/DOCX; no se presentan como comprobados. CI del código `70d2c40`: PostgreSQL real y 29 pruebas E2E aprobados, ejecución `38477948969`.
