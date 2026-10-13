# MASCLI · TypeScript y arquitectura hexagonal

La nueva versión de MASCLI es un monorepo TypeScript para la gestión y el análisis territorial. Su evolución se registra en el [ODD de migración](odd/tasks/typescript-hexagonal-migration.md) y en los [ADRs](docs/adr/README.md).

## Arquitectura visual con Archify

[![Arquitectura hexagonal TypeScript de MASCLI](docs/diagrams/arquitectura.png)](docs/diagrams/arquitectura.html)

- [Mapa interactivo](docs/diagrams/arquitectura.html): SPA, contratos compartidos, Hono, casos de uso, dominio, adaptadores, PostgreSQL, objetos y embeddings.
- [Guía de arquitectura y regeneración](docs/ARQUITECTURA.md).
- [Fuente JSON editable](docs/diagrams/arquitectura.json) y [verificación](docs/VERIFICACION.md).

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

## Estado del ODD

T1–T14 están completos en el ODD: API y secciones web en TypeScript, benchmarks, migrador con ensayo sintético y paridad E2E. La integración incorpora los controles de ADR 0009: MFA obligatorio por defecto, comprobación de origen en escrituras y hosts permitidos. El primer acceso permite configurar un autenticador antes de seleccionar proyecto.

Consulta [la verificación de T14](docs/migration/t14-verification.md) y [la consolidación](docs/migration/main-consolidation.md). El runtime usa únicamente TypeScript. La referencia Python congelada está en [`reference/python`](reference/python/README.md) y se conserva para pruebas de paridad y del migrador. La validación científica externa del IRSA sigue siendo un proceso separado.

La primera publicación será una demo académica/personal, con datos sintéticos y una URL gratuita del proveedor. No requiere comprar un dominio de Cloudflare ni migrar datos reales. Estado y configuración en [la guía de despliegue](docs/deployment/readiness.md).

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
