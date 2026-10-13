# Demo académica gratuita en Vercel

Este adaptador despliega la SPA React y la API Hono existente. No duplica las reglas de negocio, no usa Python y no migra datos reales. El proyecto es `mascli-demo-academica`, en el equipo `agurtofarfanalbert-8641s-projects`.

Configuración del proyecto: framework Hono, Node 22, raíz `apps/hosting`, archivos externos a la raíz habilitados, instalación `corepack pnpm install --frozen-lockfile`, build `node build.mjs`. El build compila la SPA y copia únicamente sus archivos a `public`; agrega el aviso de datos sintéticos y del límite de envío. `public` es generado y no se versiona. En el checkout efímero de Vercel, el build emite kernel/contratos a JavaScript con declaraciones de tipos y ajusta sus exports de runtime a dist: Vercel transforma .ts en .js pero no corrige los exports originales de los paquetes workspace. Ese ajuste no se hace en el build local normal ni se versiona; para reproducir el modo VERCEL=1, usar un worktree desechable. Las rutas públicas de la SPA se sirven antes de inicializar PostgreSQL y se resuelven respecto al módulo, no al directorio de ejecución.

El backend se inicializa en la primera petición; peticiones simultáneas comparten ese arranque. Un fallo devuelve 503 sin revelar credenciales y permite reintentar. PostgreSQL es obligatorio; no hay fallback a PGlite en el alojamiento. La conexión aplica las migraciones antes de construir la API y se libera si el arranque falla.

Las evidencias usan el puerto ObjectStorage con Vercel Blob **privado**, conservando las claves deterministas. La descarga pasa por la sesión, alcance y permisos de MASCLI; no se publican URLs de objetos. No se usan archivos efímeros como almacén de evidencias. El límite es 3 MiB por evidencia y 4 MiB por petición completa, incluyendo los archivos de comparación y el multipart.

## Configuración externa

El proyecto Vercel y el almacén privado están creados. La conexión de una base nueva **Neon Free**, exclusiva para datos sintéticos, requiere una acción del propietario en la pestaña Storage: las herramientas de esta sesión no crean esa integración.

Variables necesarias, con valores exclusivamente en el almacén de secretos:

| Variable                                                                   | Uso                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MASCLI_DATABASE_URL`                                                      | Conexión PostgreSQL de la demo, con TLS; puede configurarse desde la integración Neon. No reutilizar una base con datos reales. |
| `MASCLI_DATA_KEY`                                                          | Clave base64 de 32 bytes, estable entre despliegues.                                                                            |
| `MASCLI_ADMIN_USERNAME`, `MASCLI_ADMIN_PASSWORD`, `MASCLI_ADMIN_FULL_NAME` | Bootstrap de administración sintética sobre la base vacía.                                                                      |
| `BLOB_READ_WRITE_TOKEN`                                                    | Token del almacén privado conectado al proyecto. Solo servidor.                                                                 |
| `MASCLI_REQUIRE_MFA=1`, `MASCLI_COOKIE_SECURE=1`                           | Controles de seguridad de la demo pública.                                                                                      |
| `MASCLI_ALLOWED_HOSTS`                                                     | Hosts públicos explícitos. Si no se configura, el adaptador usa los hosts del despliegue proporcionados por Vercel.             |
| `MASCLI_OLLAMA_URL`                                                        | Sin servicio de embeddings contratado; el modo automático usa reglas.                                                           |

No se configura ninguna variable `VITE_*` con secretos. Las credenciales iniciales y la copia de la clave generadas durante esta sesión están fuera del repositorio, con permisos 0600. Inscribir MFA en el primer acceso y retirar la contraseña bootstrap del entorno una vez comprobado el usuario persistido.

El adaptador acepta la conexión de la integración como `DATABASE_URL` o `POSTGRES_URL` cuando `MASCLI_DATABASE_URL` no está definida. Conecta exclusivamente la base sintética nueva. No pegarla en PR, logs o chat. Para migraciones/roles, seguir [readiness](../../docs/deployment/readiness.md), usando una conexión apropiada para el arranque y una base sintética vacía.

## Verificación local

`pnpm verify` aprobado: API 439 aprobadas y 7 pruebas PostgreSQL opcionales omitidas, web 99, kernel 3, limpieza E2E 3, hosting 6 y herramientas 4. Tipos, límites y lint/formato también aprobados; build de SPA con aviso de demo aprobado. La revisión independiente comprobó las pruebas del adaptador, incluida la regresión de hosts, sus tipos y las opciones reales del SDK instalado. La CI de consolidación previa ejecutó PostgreSQL real y las 29 pruebas E2E sin omisiones.

## Antes de anunciar la URL

Comprobar el build de Vercel: Argon2 nativo, archivos SQL, rutas `import.meta.url`, worker PDF y referencias incluidas. Después comprobar salud, login/MFA, persistencia de sesión/proyecto, CRUD sintético, evidencia con descarga idéntica, PDF/DOCX, comparación de dos archivos pequeños y CSP. La revisión y las pruebas locales del adaptador no equivalen a esa comprobación pública.

Vercel Hobby corresponde al uso académico/personal no comercial confirmado por el usuario. Se usa el subdominio del proveedor; no se compra dominio ni se activa un plan de pago. Blob Hobby tiene cuotas gratuitas: si se agotan, el servicio se suspende hasta su renovación, sin contratar Pro.

Referencias oficiales: [Hono en Vercel](https://vercel.com/docs/frameworks/backend/hono), [Hobby](https://vercel.com/docs/plans/hobby), [Blob privado y SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), [cuotas Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing), [Neon Free](https://neon.com/pricing).
