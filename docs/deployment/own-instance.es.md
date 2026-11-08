# Tu propia instancia de SIPGES

Esta guía es para quien hace un fork de SIPGES y quiere ejecutarlo en **sus propias** cuentas de GitHub, Neon y Cloudflare. Cada servicio se cobra a tu nombre, y el código, la base de datos y los archivos de evidencia quedan en tus cuentas. Nada en el repositorio apunta a la cuenta de otra persona: los valores que cambian según el dueño son variables y secretos de GitHub que configuras una sola vez.

[English version](own-instance.md)

El despliegue en `sipges.dreamcoder-dev08.workers.dev` es la instancia de referencia del propietario del repositorio. No la usas ni necesitas acceso a ella.

## Ruta rápida

1. Haz un fork del repositorio y habilita GitHub Actions en el fork.
2. Crea la base de datos y el rol en Neon: [§2](#2-neon).
3. Crea los recursos de Cloudflare y el token de API: [§3](#3-cloudflare).
4. Guarda los secretos del Worker en Cloudflare: [§4](#4-secretos-del-worker).
5. Configura las variables y secretos de GitHub: [§5](#5-variables-y-secretos-de-github).
6. Ejecuta **Deploy Workers** a mano e inicia sesión: [§6](#6-primer-despliegue-y-primer-inicio-de-sesión).

Usa datos sintéticos hasta que decidas cargar registros reales.

## 1. Qué creas, a tu nombre

| Cuenta o recurso | Para qué | Quién paga |
| --- | --- | --- |
| Fork en GitHub | Guarda el código y ejecuta la CI y el flujo de despliegue | Tú (capa gratuita o tu plan) |
| Proyecto de Neon | PostgreSQL con seguridad por filas (RLS) | Tú |
| Cuenta de Cloudflare con el plan **Workers Paid** | El Worker, Hyperdrive y R2. El plan gratuito permite 10 ms de CPU por petición y un inicio de sesión cuesta unos 250 ms | Tú |
| Configuración de Hyperdrive | El Worker llega a Neon solo a través de ella | Cuenta de Cloudflare |
| Bucket de R2 `sipges-evidence` | Archivos de evidencia, privado | Cuenta de Cloudflare |
| Subdominio `workers.dev` o dominio propio | La dirección pública | Cuenta de Cloudflare |
| Token de API de Cloudflare | Permite al flujo de despliegue publicar | Cuenta de Cloudflare |
| Cliente OAuth de Google (opcional) | «Entrar con Google» para cuentas invitadas | Proyecto de Google Cloud |
| Clave de un proveedor de IA o un servidor Ollama (opcional) | Prosa del analista, modo semántico | El proveedor o tu servidor |

Containers, del plan Paid, solo hace falta para el Worker Go de prueba, que es opcional y que el despliegue normal no publica ([guía de la prueba Go](go-trial-runbook.md)).

## 2. Neon

1. Crea un proyecto de Neon. Elige la región más cercana a tus usuarios.
2. Crea el rol de la aplicación y la base de datos, con el rol propietario del proyecto, usando el SQL de [readiness §3](readiness.md#3-postgresql-with-a-least-privilege-role). El rol no debe ser superusuario ni tener `BYPASSRLS`, o el aislamiento entre proyectos no se cumple.
3. Guarda dos cadenas de conexión en tu gestor de contraseñas, nunca en el repositorio:
   - la **directa** (no la del pooler) con `sslmode=require`, para las migraciones: será el secreto de GitHub `SIPGES_MIGRATION_DATABASE_URL`;
   - el mismo inicio de sesión, para Hyperdrive en el paso siguiente.

## 3. Cloudflare

Ejecuta esto desde `apps/hosting-cloudflare` después de `pnpm install`:

```sh
pnpm exec wrangler login
pnpm exec wrangler hyperdrive create sipges --caching-disabled true \
  --connection-string "<la-cadena-de-conexion-de-neon>"
pnpm exec wrangler r2 bucket create sipges-evidence
```

- `hyperdrive create` imprime un **id** de 32 caracteres hexadecimales. Ese es `SIPGES_HYPERDRIVE_ID`. Mantén desactivada la caché de consultas de Hyperdrive: una lectura en caché puede mantener viva una sesión revocada (el despliegue lo reafirma cada vez).
- El Worker se llama `sipges`, así que su dirección es `https://sipges.<tu-subdominio>.workers.dev`. Tu subdominio de workers.dev aparece en el panel de Cloudflare, en Workers & Pages. Para un dominio propio, agrégalo al Worker allí y usa ese nombre de host.
- Token de API: en el panel, My Profile → API Tokens → Create Token. Parte de la plantilla «Edit Cloudflare Workers», limítala a tu cuenta y comprueba que pueda editar scripts de Workers y configuraciones de Hyperdrive. No agregues nada más. El id de la cuenta está en el resumen del panel.

## 4. Secretos del Worker

El Worker los lee en ejecución, así que viven en Cloudflare y no en GitHub. Configúralos antes del primer despliegue (`wrangler secret put <NOMBRE>` pide el valor, así que nunca queda en el historial de tu terminal):

| Nombre | Obligatorio | Valor |
| --- | --- | --- |
| `SIPGES_DATA_KEY` | sí | 32 bytes aleatorios en base64, por ejemplo `openssl rand -base64 32`. Si la pierdes, los campos cifrados dejan de poder leerse: respáldala junto con la base de datos |
| `SIPGES_ADMIN_USERNAME`, `SIPGES_ADMIN_PASSWORD`, `SIPGES_ADMIN_FULL_NAME` | sí, para el primer administrador | Se usan solo mientras la base de datos no tiene cuentas |
| `SIPGES_GOOGLE_CLIENT_ID`, `SIPGES_GOOGLE_CLIENT_SECRET`, `SIPGES_GOOGLE_ADMIN_EMAIL` | no | Entrada con Google. URI de redirección autorizada: `https://<tu-host>/auth/google/callback` |
| `SIPGES_ANALYST_PROVIDER`, `ANTHROPIC_API_KEY` | no | Desactivado por defecto. Envía al proveedor texto de informes sin restricción, así que actívalo solo con la aprobación del dueño de los datos |
| `SIPGES_OLLAMA_URL` | no | Una dirección que el Worker alcance por HTTPS. El valor local `127.0.0.1:11434` no existe en Workers |

Sin `SIPGES_DATA_KEY` el Worker no arranca, y sin los valores del administrador una base de datos vacía no tiene primera cuenta. Si `wrangler secret put` ofrece crear el Worker `sipges`, acepta. El resto de las variables y qué hace cada una está en [Cloudflare Workers §2](cloudflare-workers.md#2-set-variables-and-secrets).

## 5. Variables y secretos de GitHub

En el fork: Settings → Secrets and variables → Actions.

**Variables del repositorio** (pestaña Variables). El despliegue se detiene antes de compilar con `Missing GitHub Actions variable <NOMBRE>: see docs/deployment/own-instance.md` si falta alguna.

| Nombre | Valor | De dónde sale |
| --- | --- | --- |
| `SIPGES_PUBLIC_HOST` | `sipges.<tu-subdominio>.workers.dev`, o tu host propio. Sin `https://` ni ruta | §3 |
| `SIPGES_HYPERDRIVE_ID` | 32 caracteres hexadecimales | Lo imprime `hyperdrive create` en §3 |
| `SIPGES_RUNS_ON` | Opcional. Lista JSON de etiquetas de runner, como `["self-hosted"]`. Sin definir usa los runners de GitHub | [Runner de CI](../operations/ci-runner.md) |

**Secretos**, en el entorno llamado `production` (Settings → Environments → New environment, y agrégalos ahí):

| Nombre | Valor | De dónde sale |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | El token | §3 |
| `CLOUDFLARE_ACCOUNT_ID` | El id de tu cuenta | §3 |
| `SIPGES_MIGRATION_DATABASE_URL` | URL directa de Neon con `sslmode=require` | §2 |

Hay dos nombres más, solo para la prueba Go opcional, que despliegas a mano y no por GitHub: `SIPGES_GO_PUBLIC_HOST` y `SIPGES_GO_HYPERDRIVE_ID` (ver la [guía](go-trial-runbook.md)). Déjalos sin definir si no la usas.

## 6. Primer despliegue y primer inicio de sesión

1. Comprueba que la CI está en verde en tu `main`. **Deploy Workers** arranca solo cuando la CI termina bien tras un push a `main`.
2. Para la primera ejecución, abre Actions → Deploy Workers → Run workflow, rama `main`.
3. El trabajo comprueba las variables, compila, aplica las migraciones, despliega y prueba `/health/ready`. Si la prueba falla, hace rollback; en el primerísimo despliegue no hay versión anterior a la que volver, así que lee el registro y corrige la causa.
4. Abre `https://<tu-host>`. Inicia sesión con el administrador del §4. La MFA es obligatoria por defecto: registra tu autenticador en el primer inicio de sesión.
5. Crea un proyecto e invita a las personas desde dentro de la aplicación.

## Costos

SIPGES no agrega ninguna tarifa propia. Pagas a cada proveedor según tu plan; consulta sus precios vigentes antes de empezar:

- Cloudflare: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/) y [Containers](https://developers.cloudflare.com/containers/pricing/) si pruebas Go.
- Neon: [precios](https://neon.com/pricing).
- GitHub Actions: [planes de GitHub](https://github.com/pricing).
- Anthropic, solo si lo activas: [precios](https://www.anthropic.com/pricing).

El Worker además ejecuta un cron cada 15 minutos, que cuenta dentro del uso de Workers.

## Actualizar desde el repositorio original

```sh
git remote add upstream <url-del-repositorio-original>   # una sola vez
git fetch upstream
git switch main
git merge upstream/main
git push origin main
```

Resuelve los conflictos en tu fork, deja que la CI pase y el despliegue corre solo. Las migraciones son aditivas y se aplican antes de que el código nuevo entre en servicio. Tus variables y secretos quedan en tus cuentas, así que una fusión nunca los cambia.

## Desarrollo local

`pnpm --filter @sipges/hosting-cloudflare dev` ejecuta `wrangler dev` con los valores por defecto del repositorio (host `localhost` y un id de Hyperdrive de relleno); apúntalo a un PostgreSQL local con `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`. El despliegue escribe `wrangler.deploy.jsonc` a partir de tus variables; git lo ignora.

## Dónde viven tus datos

Los registros están en tu proyecto de Neon, los archivos de evidencia en tu bucket de R2 y los secretos en tus cuentas de Cloudflare y GitHub. El repositorio no contiene datos ni valores de ninguna cuenta. Para dejar de pagar, elimina el Worker, la configuración de Hyperdrive y el bucket de R2 en Cloudflare, y el proyecto en Neon.
