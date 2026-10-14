# Demo académica gratuita en Vercel

## Acceso simplificado (2026-10-14)

Por petición del propietario, esta demo académica con datos sintéticos usa `MASCLI_REQUIRE_MFA=0` en producción. Permite entrar con usuario y contraseña sin inscribir un autenticador. Esta es una configuración del proyecto Vercel, no un cambio del valor predeterminado de MASCLI. Una cuenta que active TOTP voluntariamente seguirá solicitando su código al iniciar sesión.

Despliegue `dpl_A46t3io9oYwH1WZT2dcYn9Sudk8L`, revisión `b19cd6b70d40b97614a5f052f915649b81d00286`, READY. Chromium público comprobó login con contraseña, acceso directo al dashboard y administración, persistencia tras recargar, cookies Secure/HttpOnly/SameSite=Strict y logout. El propietario no necesita completar la pantalla de inscripción MFA para esta demo: puede abrir la URL raíz. Esta comprobación sustituye el requisito de inscripción pendiente descrito en la verificación histórica del 2026-10-13.

Este adaptador despliega la SPA React y la API Hono existente. No duplica las reglas de negocio, no usa Python y no migra datos reales. El proyecto es `mascli-demo-academica`, en el equipo `agurtofarfanalbert-8641s-projects`.

Configuración del proyecto: framework Hono, Node 22, raíz `apps/hosting`, archivos externos a la raíz habilitados, instalación `corepack pnpm install --frozen-lockfile`, build `node build.mjs`. El build compila la SPA y copia únicamente sus archivos a `public`; agrega el aviso de datos sintéticos y del límite de envío. `public` es generado y no se versiona. En el checkout efímero de Vercel, el build emite kernel/contratos a JavaScript con declaraciones de tipos y ajusta sus exports de runtime a dist: Vercel transforma .ts en .js pero no corrige los exports originales de los paquetes workspace. Ese ajuste no se hace en el build local normal ni se versiona; para reproducir el modo VERCEL=1, usar un worktree desechable. Las rutas públicas de la SPA se sirven antes de inicializar PostgreSQL y se resuelven respecto al módulo, no al directorio de ejecución.

El backend se inicializa en la primera petición; peticiones simultáneas comparten ese arranque. Un fallo devuelve 503 sin revelar credenciales y permite reintentar. PostgreSQL es obligatorio; no hay fallback a PGlite en el alojamiento. La conexión aplica las migraciones antes de construir la API y se libera si el arranque falla.

Las evidencias usan el puerto ObjectStorage con Vercel Blob **privado**, conservando las claves deterministas. La descarga pasa por la sesión, alcance y permisos de MASCLI; no se publican URLs de objetos. No se usan archivos efímeros como almacén de evidencias. El límite es 3 MiB por evidencia y 4 MiB por petición completa, incluyendo los archivos de comparación y el multipart.

## Configuración externa

El propietario conectó Neon mediante la integración Storage de Vercel. `DATABASE_URL` y `DATABASE_URL_UNPOOLED` están configuradas para producción; la configuración temporal anterior se renombró a `MASCLI_TEMPORARY_DATABASE_URL`, que el adaptador no utiliza. La demo usa la base vinculada por el propietario, no el proyecto anónimo temporal. No se accedió a datos históricos ni se migraron datos reales.

Variables necesarias, con valores exclusivamente en el almacén de secretos:

| Variable                                                                   | Uso                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MASCLI_DATABASE_URL`                                                      | Conexión PostgreSQL de la demo, con TLS; puede configurarse desde la integración Neon. No reutilizar una base con datos reales. |
| `MASCLI_DATA_KEY`                                                          | Clave base64 de 32 bytes, estable entre despliegues.                                                                            |
| `MASCLI_ADMIN_USERNAME`, `MASCLI_ADMIN_PASSWORD`, `MASCLI_ADMIN_FULL_NAME` | Bootstrap de administración sintética sobre la base vacía.                                                                      |
| `BLOB_READ_WRITE_TOKEN`                                                    | Token del almacén privado conectado al proyecto. Solo servidor.                                                                 |
| `MASCLI_REQUIRE_MFA=0`, `MASCLI_COOKIE_SECURE=1`                           | Acceso con contraseña para la demo sintética; cookies seguras habilitadas.                                                      |
| `MASCLI_ALLOWED_HOSTS`                                                     | Hosts públicos explícitos. Si no se configura, el adaptador usa los hosts del despliegue proporcionados por Vercel.             |
| `MASCLI_OLLAMA_URL`                                                        | Sin servicio de embeddings contratado; el modo automático usa reglas.                                                           |

### Entrar con Google (opcional, ADR 0010)

Solo entran los correos que un administrador vincula a una cuenta existente; un correo desconocido no crea cuentas. La sesión abierta con Google cuenta como segundo factor, así que no hace falta inscribir TOTP.

1. En Google Cloud Console, «APIs y servicios» → «Pantalla de consentimiento de OAuth»: tipo Externo, en modo de prueba, y añadir como usuarios de prueba los correos que vayan a entrar.
2. «Credenciales» → «Crear credenciales» → «ID de cliente de OAuth», tipo «Aplicación web». En «URI de redireccionamiento autorizados» añadir `https://<host público>/auth/google/callback` por cada host con el que se entre (por ejemplo `https://mascli-demo-academica-agurtofarfanalbert-8641s-projects.vercel.app/auth/google/callback`).
3. En Vercel → Settings → Environment Variables (Production): `MASCLI_GOOGLE_CLIENT_ID`, `MASCLI_GOOGLE_CLIENT_SECRET` y, para entrar como administrador sin TOTP, `MASCLI_GOOGLE_ADMIN_EMAIL` con el correo de Google del propietario. Volver a desplegar.
4. Para cada persona invitada: Administración → crear su cuenta (rol `consulta` para solo lectura), «Conceder acceso» al proyecto y «Entrar con Google» → vincular su correo.

| Variable                                                 | Uso                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `MASCLI_GOOGLE_CLIENT_ID`, `MASCLI_GOOGLE_CLIENT_SECRET` | Cliente OAuth de Google. Ambas o ninguna; sin ellas el botón no aparece.          |
| `MASCLI_GOOGLE_ADMIN_EMAIL`                              | Vincula el administrador bootstrap a ese correo al arrancar, si aún no tiene uno. |

No se configura ninguna variable `VITE_*` con secretos. Las credenciales iniciales y la copia de la clave generadas durante esta sesión están fuera del repositorio, con permisos 0600. Inscribir MFA en el primer acceso y retirar la contraseña bootstrap del entorno una vez comprobado el usuario persistido.

El adaptador acepta la conexión de la integración como `DATABASE_URL` o `POSTGRES_URL` cuando `MASCLI_DATABASE_URL` no está definida. Conecta exclusivamente la base sintética nueva. No pegarla en PR, logs o chat. Para migraciones/roles, seguir [readiness](../../docs/deployment/readiness.md), usando una conexión apropiada para el arranque y una base sintética vacía.

## Verificación local

`pnpm verify` aprobado: API 439 aprobadas y 7 pruebas PostgreSQL opcionales omitidas, web 99, kernel 3, limpieza E2E 3, hosting 6 y herramientas 4. Tipos, límites y lint/formato también aprobados; build de SPA con aviso de demo aprobado. La revisión independiente comprobó las pruebas del adaptador, incluida la regresión de hosts, sus tipos y las opciones reales del SDK instalado. La CI de consolidación previa ejecutó PostgreSQL real y las 29 pruebas E2E sin omisiones.

## Verificación pública (2026-10-13)

URL: https://mascli-demo-academica-agurtofarfanalbert-8641s-projects.vercel.app/login

Despliegue `dpl_82Q51rFoAhxYALtRchiTDD8pbyC9`, código `70d2c40`, estado READY. Comprobados en Chromium: SPA y aviso sintético, CSP estricta, `/health` 200, contraseña bootstrap válida y cuenta persistida, cookie Secure/HttpOnly/SameSite=Strict, sesión tras recargar, vista móvil sin desbordamiento y logout con revocación. La autenticación ejecuta Argon2 real y el arranque aplica SQL real sobre Neon. Administración devuelve 403 hasta inscribir MFA; no se activó un autenticador en nombre del propietario.

Pendientes después de su inscripción: smoke público de CRUD, autorización por proyecto, evidencia Blob con descarga idéntica, worker PDF, DOCX y comparación. Las 29 pruebas E2E de CI con PostgreSQL real aprobaron; no equivalen a ese smoke en Vercel/Blob. Las credenciales iniciales están fuera de Git y no se incluyen aquí.

Vercel Hobby corresponde al uso académico/personal no comercial confirmado por el usuario. Se usa el subdominio del proveedor; no se compra dominio ni se activa un plan de pago. Blob Hobby tiene cuotas gratuitas: si se agotan, el servicio se suspende hasta su renovación, sin contratar Pro.

Referencias oficiales: [Hono en Vercel](https://vercel.com/docs/frameworks/backend/hono), [Hobby](https://vercel.com/docs/plans/hobby), [Blob privado y SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), [cuotas Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing), [Neon Free](https://neon.com/pricing).
