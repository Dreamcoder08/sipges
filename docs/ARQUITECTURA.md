# Arquitectura TypeScript de MASCLI · ODD

El [mapa interactivo Archify](diagrams/arquitectura.html) documenta la versión TypeScript de MASCLI en la rama de la plataforma de ontología, commit `49290423d4ea2de329b0b09924916cd2e9a588ac`. Su marco de decisiones son los ODD de [migración](../odd/tasks/typescript-hexagonal-migration.md) y de [ontología e inteligencia](../odd/tasks/ontology-intelligence-platform.md) y las enmiendas de los [ADRs](adr/README.md). Las referencias del mapa apuntan al código de esa revisión. La [verificación de T11 completo](migration/t11-verification.md) registra los flujos comprobados y sus límites.

## Recorrido y reglas de dependencia

La SPA React llama a Hono por HTTP del mismo origen. Zod valida las respuestas del cliente y las entradas HTTP. La sesión y el proyecto activo se mantienen en cookies HttpOnly; cambiar proyecto llama al servidor. Las rutas protegidas pasan por sesión/origen, tenancy y autorización por rol antes del caso de uso.

El backend organiza cada contexto en `http`, `application`, `domain` e `infrastructure`. HTTP interpreta entradas y llama a la aplicación; la aplicación ejecuta reglas del dominio e invoca interfaces de puertos. Los adaptadores implementan esas interfaces. `main.ts` abre recursos y `compose.ts` construye los servicios mediante inyección manual. La flecha aplicación → adaptadores representa una llamada a una implementación inyectada: el código de aplicación no importa infraestructura.

`dependency-cruiser` comprueba las reglas de dependencia: dominio puro, aplicación sin dependencias de HTTP/infraestructura, contextos comunicándose mediante APIs públicas de aplicación y features web aisladas. Los componentes del mapa son capas y responsabilidades lógicas dentro del monorepo, no microservicios desplegados individualmente. ODD y ADRs son documentación que guía el desarrollo, no servicios del runtime.

## Stack y decisiones vigentes

| Capa | Implementación | Decisión |
| --- | --- | --- |
| Web | React 19, Vite, TanStack Router/Query, CSS Modules | [ADR 0006](adr/0006-frontend-architecture.md) y [estado T11](migration/web.md) |
| HTTP | Hono sobre Node.js; validación Zod | [ADR 0007](adr/0007-http-contract-and-errors.md) |
| Aplicación y dominio | Puertos, políticas puras, `Result` y kernel compartido | [ADR 0002](adr/0002-hexagonal-architecture-and-bounded-contexts.md) |
| Composición | Inyección manual en `main.ts` / `compose.ts` | [ADR 0002](adr/0002-hexagonal-architecture-and-bounded-contexts.md) |
| SQL | Puerto SqlClient, postgres.js y migraciones `.sql` | Enmienda del [ADR 0003](adr/0003-persistence-and-tenant-isolation.md): Drizzle no se utiliza |
| Objetos | ObjectStorage local, S3-compatible con SigV4 o Blob privado | [Migración T8](migration/evidence.md) |
| Procesamiento | DocumentReader: unpdf/pdf.js y fflate; ReportRenderer: docx | [Migración T9](migration/documents.md) |
| Embeddings | EmbeddingProvider con adaptador Ollama | [Migración T10](migration/operations.md) |
| Ontología | Catálogo de objetos y vínculos, historial por trigger, búsqueda GIN, grafo y cronología | [ADR 0011](adr/0011-ontology-links-and-provenance.md) |
| Observabilidad y clasificación | Request id, logs JSON, métricas Prometheus; marcas con RLS | [ADR 0012](adr/0012-observability-and-classification.md) |
| Analista | Informe extractivo con citas; Narrator opcional con Claude (`@anthropic-ai/sdk`) | [ADR 0013](adr/0013-cited-analyst-briefings.md) |
| Herramientas | pnpm, TS 7 por paquete / TS 6 para herramientas, ESLint/Prettier y dependency-cruiser | Enmienda del [ADR 0001](adr/0001-monorepo-and-toolchain.md): sin Turborepo/Biome |

El adaptador de demo en `apps/hosting` reutiliza Hono y añade Blob privado al puerto ObjectStorage. La demo académica está publicada en Vercel con la integración PostgreSQL Neon del propietario. Se comprobaron salud, login, sesión y el bloqueo previo a MFA en la URL pública. El propietario debe inscribir su autenticador antes del smoke público de CRUD, evidencias y documentos; esos flujos ya se verificaron en CI contra PostgreSQL sintético.

El mapa agrupa los contextos identity, tenancy, records, ontology, analyst, audit, indicators, analytics, evidence, documents, intelligence, prevention management y reference. La composición de gerencia consulta APIs de aplicación de inteligencia y prevención; no debe acceder directamente a sus tablas. Los formatos de reporte usan el modelo `ReportDocument` del kernel.

## Persistencia y aislamiento

`MASCLI_DATABASE_URL` selecciona PostgreSQL mediante postgres.js. Sin esa variable, desarrollo usa PGlite embebido; `NODE_ENV=production` exige la URL. Las migraciones se aplican al arrancar. `withTenant` establece `app.tenant_id` y `SET LOCAL ROLE mascli_tenant` dentro de la transacción. Las tablas territoriales llevan RLS, mientras usuarios, sesiones, tenants y grants son globales. Los cambios de registros y su auditoría se escriben en la misma transacción. Esto describe los controles implementados, sin constituir una auditoría de seguridad.

La configuración IRSA y los snapshots pasan a SQL. Los adjuntos usan el adaptador local o S3 según `MASCLI_STORAGE`; los metadatos quedan en PostgreSQL. El laboratorio procesa documentos mediante puertos y genera DOCX sin invocar Python. Ollama se llama solo al solicitar semántica: `mode=rules` devuelve el análisis por reglas sin invocar embeddings. El adaptador de referencias lee geometría y entidades del repositorio únicamente para su empresa/proyecto registrado; no ofrece la geometría de Sechura como fallback de otro tenant. No se representa ningún proveedor alojado como si ya estuviera desplegado.

## Estado del ODD en esta revisión

| Fase | Estado registrado |
| --- | --- |
| T1–T10 | Contratos, ADRs, workspace y contextos backend completados |
| T11a/b | Shell, login/MFA, selección/cambio de proyecto, dashboard, registros y evidencias completados |
| T11c–d | IRSA/validación, alertas/mapa, análisis/documentos, gerencia/inteligencia, administración/auditoría/metodología completados |
| T12 | Benchmarks sintéticos completados; Go/Rust no justificado por los resultados |
| T13 | Migrador SQLite → PostgreSQL y ensayo sintético completados |
| T14 | Paridad E2E y preparación del despliegue completadas |
| Ontología T1–T11 | Historial, vínculos tipados e inferidos, búsqueda, grafo, observabilidad, clasificación, importación CSV, analista con citas, cronología y E2E |

La implementación nueva es TypeScript; Python permanece en `reference/python` como referencia de comportamiento y fixtures de paridad, sin ser dependencia de ejecución. El estado de tareas proviene del ODD; T1–T14 están completos; la publicación de la demo se comprueba por separado. La validación científica externa del IRSA sigue siendo un proceso separado.

## Fuente editable y regeneración

- `diagrams/arquitectura.json`: componentes, conexiones, geometría, tarjetas y referencias Git.
- `diagrams/arquitectura.html`: visor autónomo generado; conservar los bytes generados.
- `diagrams/arquitectura.png`: vista previa del visor en escritorio.
- [Licencia Archify](ARCHIFY-LICENSE.txt) y [verificación de la entrega](VERIFICACION.md).

Herramienta: [tt-a1i/archify](https://github.com/tt-a1i/archify), revisión `c21c31ffb879668900c5487ea24993bf45d89b15`. Archify se usa para documentación y no se instala como dependencia de MASCLI. Requiere Node.js y Chrome/Chromium para la comprobación de navegador.

Clona la herramienta en una carpeta hermana y fija su revisión:

```bash
git clone https://github.com/tt-a1i/archify.git ../archify-tool
git -C ../archify-tool checkout c21c31ffb879668900c5487ea24993bf45d89b15
```

Desde la raíz de MASCLI:

```bash
ARCHIFY_UPDATE_CHECK_DISABLED=1 node ../archify-tool/archify/bin/archify.mjs finalize architecture docs/diagrams/arquitectura.json docs/diagrams/arquitectura.html --repo-root . --quality showcase --json --out-dir /tmp/mascli-archify-review
```

En PowerShell, establece `$env:ARCHIFY_UPDATE_CHECK_DISABLED="1"` antes del comando `node`. Usa una carpeta de revisión nueva al modificar el candidato y conserva los recibos anteriores. Para actualizarlo, inspecciona el código TypeScript y el ODD, ajusta responsabilidades, conexiones y referencias, y fija `meta.repository.revision` a la revisión que contiene los archivos citados. Las referencias se comprueban contra bytes comprometidos en Git.

Las etapas de validación, generación y comprobación estricta pasaron. `browser-check` de Archify falla en este entorno por el bloqueo de URLs `file://` de Chromium; la prueba HTTP adicional es independiente. Los resultados completos y sus límites figuran en [VERIFICACION.md](VERIFICACION.md).
