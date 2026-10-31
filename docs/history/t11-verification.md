# Verificación de T11 completo

Fecha: 2026-10-13. Rama: `feat/typescript-migration-11-complete`. Código fijado al commit `90c6b0e6b547eb837e70dcf01d9998ae86707d4c`. T11a/b se amplía con todas las secciones T11c/d; no quedan rutas con avisos de migración.

## Comprobación automática

| Comprobación | Resultado |
| --- | --- |
| `corepack pnpm check` | Pasó: ESLint/Prettier, límites de dependencias, tipos y pruebas |
| Límites arquitectónicos | 307 módulos / 821 dependencias; features aisladas y API hexagonal |
| Pruebas API | 383 aprobadas / 6 omitidas (integración opcional PostgreSQL real) |
| Pruebas web | 98 aprobadas |
| Pruebas kernel | 3 aprobadas |
| Total | 484 aprobadas |
| `corepack pnpm --filter @mascli/web build` | Pasó; bloque inicial 143.01 kB gzip y bloques independientes para las funciones nuevas |
| Revisión independiente | Sin hallazgos bloqueantes; 43 pruebas focalizadas aprobadas por el revisor |

Las pruebas nuevas cubren contratos, permisos, escrituras y descargas con alcance fijado, conservación de borradores, bloqueo de operaciones incompatibles, fallos/reintentos, cambio de proyecto durante operaciones, descarte de clasificación obsoleta y CSV seguro. El endpoint de geometría se comprobó contra otra empresa con el mismo identificador de proyecto: devuelve `available: false` y `data: null`.

La primera ejecución remota detectó una incompatibilidad de la propia prueba de descarga: el `Blob` nativo de Node 22 no es aceptado por `FileReader` de jsdom. Se reprodujo con Node 22.23.3 y se corrigió leyendo cada implementación con su API, manteniendo la aserción de bytes, el alcance y la limpieza de URL. La comprobación focalizada pasó en Node 22 y Node 24; el código de descarga de producción no cambió.

## Navegador → API → datos → respuesta

Chromium accedió a la SPA y Hono del mismo origen, con PGlite y archivos en un directorio temporal. Se usaron únicamente cuentas, registros y documentos sintéticos. Las once rutas nuevas cargaron las respuestas del backend real; no se sustituyó la API por mocks en esta comprobación.

| Flujo | Evidencia observada |
| --- | --- |
| Registros y evidencias anteriores | Seis módulos y compromisos; multipart real; bytes de descarga iguales al archivo original; edición conserva adjuntos; cancelar/confirmar eliminación; aislamiento entre proyectos |
| IRSA | Corte creado desde la interfaz, persistido y mostrado en el historial; estado científico del servidor visible |
| Clasificación de eventos | Análisis de un borrador y aplicación explícita de dimensión; sin guardar ni validar automáticamente el hecho |
| Mapa | Selección de concesión, zoom y descarga CSV con código/vértices; fuente/CRS visibles; proyecto distinto muestra ausencia de geometría |
| Documentos | TXT real analizado con huella; candidatos importados; decisión corroborada con nota; comparación; DOCX descargado con firma ZIP válida |
| Estrategia | Creación persistida desde los cinco formularios: intereses, diálogos, oportunidades, hechos y AARC |
| Inteligencia | Modo automático con respaldo por reglas ante modelo no disponible; alerta persistida y revisión humana |
| Prevención y gerencia | Plan desde alerta corroborada; cierre con nota y 100%; historial/métricas; CSV real descargado |
| Administración | Cuenta de consulta creada y acceso concedido; exportación JSON sin material de credenciales; proyecto creado y selector actualizado; revocación/desactivación confirmadas |
| MFA personal | Configuración, generación de código TOTP válido, activación aceptada por el servidor y secreto eliminado de la pantalla |
| Auditoría | Operaciones del proyecto visibles, incluido el plan preventivo |
| Rol de consulta | Sin creación de cuentas ni registro de alertas; análisis por reglas permitido |
| Móvil | Las once rutas comprobadas a 390×844 sin desbordamiento horizontal de página |
| JavaScript | Sin errores de página durante los flujos completos |

Capturas revisadas visualmente: [mapa en escritorio](assets/t11-map-desktop.png), [gerencia en escritorio](assets/t11-management-desktop.png) y [auditoría móvil](assets/t11-audit-mobile.png). Las tablas extensas permanecen dentro de regiones con desplazamiento; la captura del mapa usa zoom y puede recortar concesiones en los bordes de la vista.

## Documentación y límites

El [ODD](../../odd/tasks/typescript-hexagonal-migration.md) registra T11 completo. [La guía web](../migration/web.md) explica funciones, permisos y diferencias deliberadas. El [mapa Archify](../diagrams/arquitectura.html) apunta al commit anterior; [su verificación](archify-verification.md) separa las comprobaciones aprobadas del bloqueo de Chromium sobre `file://`.

Estas pruebas verifican los flujos de T11 con datos sintéticos, no la paridad exhaustiva ni preparación de despliegue de T14. T12 benchmarks y T13 migración/normalización siguen pendientes. No se ejecutó una migración de datos reales ni un despliegue. La ausencia de geometría o embeddings se presenta explícitamente; no se inventan mediciones, coordenadas ni validación científica IRSA.
