# MASCLI · TypeScript y arquitectura hexagonal

La nueva versión de MASCLI es un monorepo TypeScript para la gestión y el análisis territorial. Su evolución se registra en el [ODD de migración](odd/tasks/typescript-hexagonal-migration.md) y en los [ADRs](docs/adr/README.md).

## Arquitectura visual con Archify

[![Arquitectura hexagonal TypeScript de MASCLI](docs/diagrams/arquitectura.png)](docs/diagrams/arquitectura.html)

- [Mapa interactivo](docs/diagrams/arquitectura.html): SPA, contratos compartidos, Hono, casos de uso, dominio, adaptadores, PostgreSQL, objetos y embeddings.
- [Guía de arquitectura y regeneración](docs/ARQUITECTURA.md).
- [Fuente JSON editable](docs/diagrams/arquitectura.json) y [verificación](docs/history/archify-verification.md).

Descarga el HTML y ábrelo en el navegador: GitHub muestra el código del archivo y no ejecuta el visor. Selecciona un componente para consultar sus referencias de código. El visor funciona como un archivo autónomo; los enlaces al repositorio requieren conexión y permisos de acceso.

## Stack implementado

| Área | Tecnología |
| --- | --- |
| Frontend | React 19, Vite, TanStack Router y Query, CSS Modules y tokens |
| Backend | Node.js y Hono; arquitectura hexagonal por contextos |
| Contratos | Zod y tipos TypeScript compartidos en `@mascli/contracts` |
| Persistencia | PostgreSQL con postgres.js, SQL explícito y migraciones; RLS por tenant |
| Desarrollo y pruebas SQL | PGlite; PostgreSQL real para integración opcional |
| Evidencias | Puerto ObjectStorage con adaptadores local y compatible S3 |
| Documentos | unpdf/pdf.js, fflate y docx detrás de puertos |
| Semántica | Embeddings de Ollama cuando se solicita el modo semántico |
| Calidad | pnpm, TypeScript 7 por paquete, TS 6 para herramientas, ESLint, Prettier, dependency-cruiser, Vitest y MSW |

Las enmiendas de los ADRs sustituyeron Drizzle por SQL explícito y descartaron Turborepo/Biome. Go/Rust solo se incorporaría si un benchmark lo justifica; no forma parte del runtime actual.

## Estado

Versión publicada: **v1.0.0** (ver [CHANGELOG](CHANGELOG.md) y las releases de GitHub). La aplicación está desplegada en Vercel desde `main`: <https://mascli-demo-academica-agurtofarfanalbert-8641s-projects.vercel.app>.

- 14 módulos de registros (eventos, actores, directorio, demandas y compromisos, narrativas, fuentes, alertas y acciones, intereses, diálogos, oportunidades, hechos y AARC) con alta, búsqueda, ficha, edición, eliminación, importación CSV, evidencias, vínculos e historial.
- Dashboard y vista «Hoy», centro gerencial, inteligencia de redes, mapa territorial y ubicación geoespacial con mapa satelital, cronología, análisis situacional, inteligencia estratégica, IRSA, validación, automatizaciones e integración.
- Tendencia temporal de narrativas por día y categoría.
- Seguridad: MFA, entrada con Google para cuentas invitadas, comprobación de origen, aislamiento por proyecto con RLS y marcas de clasificación.
- Solo datos reales del proyecto: el caso académico sintético se retiró de la base y del código (migración 0019).

El trabajo se planifica con ODD en [`odd/tasks`](odd/tasks) y las decisiones en los [ADRs](docs/adr/README.md). El runtime usa únicamente TypeScript; la referencia Python congelada en [`reference/python`](reference/python/README.md) se conserva para pruebas de paridad y del migrador. La validación científica externa del IRSA sigue siendo un proceso separado. Despliegue y configuración en [la guía de despliegue](docs/deployment/readiness.md).

## Desarrollo local

Se recomienda Node.js 24 y Corepack. Desde la raíz:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

Antes de arrancar la API, configura `MASCLI_DATA_KEY` (base64 de 32 bytes) y `MASCLI_ADMIN_PASSWORD` (mínimo 12 caracteres para una instalación vacía). Para desarrollo HTTP local, establece `MASCLI_COOKIE_SECURE=0`. Conserva la clave de cifrado entre reinicios. Consulta las variables y comandos en [la guía del workspace](docs/migration/workspace.md).

En dos terminales, con la configuración de entorno preparada:

```bash
corepack pnpm --filter @mascli/api dev
corepack pnpm --filter @mascli/web dev
```

La API escucha por defecto en <http://127.0.0.1:8000> y Vite en <http://127.0.0.1:5173>, con proxy de las llamadas a la API. Sin `MASCLI_DATABASE_URL`, el modo desarrollo usa PGlite; producción requiere PostgreSQL. La [guía web](docs/migration/web.md) explica cómo compilar la SPA y servirla mediante `MASCLI_WEB_DIR`.
