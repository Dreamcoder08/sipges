# Deployment readiness (T14)

This is the checklist for putting the TypeScript MASCLI (`apps/api` serving the built
`apps/web`) in front of users. It records what is verified, what an operator still has to do and
what needs a decision. La primera publicación autorizada es una demo académica/personal con datos sintéticos.
El proyecto Vercel y Blob privado están creados; PostgreSQL y la comprobación de la URL siguen
pendientes. No hay migración de datos reales ni dominio adquirido.

Related documents: [workspace and configuration](../migration/workspace.md),
[legacy data migration runbook](../migration/data-migration.md),
[secure cookies](../secure-cookies.md), [web delivery and CSP](../migration/web.md),
[ADRs](../adr/README.md) and the original
[secure public deployment plan](../../odd/tasks/secure-mascli-public-deployment.md).

## What is verified before a deploy

| Gate | Command | Covers |
| --- | --- | --- |
| Static checks and unit/HTTP tests | `pnpm check` (CI job `typescript`) | Lint, format, architecture boundaries, types, API/web/kernel tests; optional real-PostgreSQL integration when `MASCLI_TEST_DATABASE_URL` is set |
| End-to-end parity | `pnpm e2e` (CI job `e2e`) | Real API + built SPA in headless Chromium against a throwaway database, see below |
| Data migration rehearsal | `pnpm --filter @mascli/api migrate:legacy` dry run / verify | Synthetic fixture in tests; a real dry run is a deploy-day step |

### End-to-end suite (`apps/e2e`)

`pnpm e2e` builds the SPA and runs Playwright (pinned `@playwright/test`, Chromium only). The
global setup starts `apps/api/src/main.ts` with `MASCLI_WEB_DIR=apps/web/dist`, a fresh PGlite
directory (or, when `MASCLI_E2E_DATABASE_URL` names a PostgreSQL server, a database it creates and
drops) and an admin password and data key generated for that run. No credential is committed or
written to disk. Every test fails on any CSP violation, page error or unexpected console error.

| Spec | Behaviour (S7 parity unless noted) |
| --- | --- |
| `01-auth-mfa` | Wrong/right password; HttpOnly + Secure + SameSite=Strict 8 h session cookie; same-app redirect after sign-in and foreign redirect ignored; sign-out revokes the token server-side; TOTP enrollment from the UI with an independent RFC 6238 authenticator, wrong code refused, **re-enrollment refused with 409** (enrollment guard), password-only login then asks for the code, next code accepted, replayed code refused |
| `02-cookie-policy` | `MASCLI_COOKIE_SECURE` unset and `1` send `Secure` and Chromium keeps **no** session over plain HTTP on a non-loopback name; exactly `0` drops `Secure` on both session and project cookies; `''`, `true`, `yes`, `01`, ` 1`, `2` stop startup before any resource opens |
| `03-tenancy` | Second tenant created from the admin screen; project switch is server-side (cookie-only request sees the new scope, survives reload, no `localStorage`); records never cross projects in the UI; foreign record/attachment ids give **404** in another granted tenant; a user without the grant gets **403** for header scope, query `project_id`, body `project_id`/`Proyecto_ID`, `/select-project` and export; **`mascli-tenant.json`** export contains only the active tenant and no identity material (S8) |
| `04-records-evidence` | Fuentes CRUD (create, view, edit keeping evidence links, delete with cancel/confirm), evidence upload and byte-identical download, event creation and search, demands/commitments toggle |
| `05-analysis-management` | IRSA snapshot saved to history; situational, strategic, consensus and integrated DOCX downloads (ZIP signature); document lab analysis (SHA-256 shown), DOCX report and candidates sent to the review inbox; management CSV scoped to the project |
| `06-csp-screens` | SPA CSP header has no `unsafe-*`; shell has no inline script/style/handlers; injected inline script and inline handler are blocked and reported; all 18 screens render with no CSP report |
| `mobile` (Pixel 7 profile) | Sign-in, menu toggle with `aria-expanded` and Escape, navigation focus, and no horizontal page scroll on every screen |

The suite found one real defect, now fixed: Zod 4 probed `new Function` on first parse, which a
strict CSP reports as a `script-src` violation. `apps/web/src/shared/config/zod.ts` turns on
jitless parsing before any schema runs.

Local run: `pnpm install --frozen-lockfile`, then `pnpm e2e`. If the browser is missing, run
`pnpm --filter @mascli/e2e exec playwright install chromium` once. To use PostgreSQL, set
`MASCLI_E2E_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres`. The role must be
able to create databases. A database named `mascli_e2e_<random>` is created and dropped.

## Pre-deployment checklist

### 1. Runtime

- [ ] Node.js 22 or later on the host. Node 24 is recommended. The API runs `.ts` files directly
      with type stripping, so it has no build step: `node apps/api/src/main.ts`.
- [ ] `pnpm install --frozen-lockfile` and `pnpm --filter @mascli/web build`. Then
      `MASCLI_WEB_DIR` points at `apps/web/dist`.
- [ ] `NODE_ENV=production`. With it, the API refuses to start without `MASCLI_DATABASE_URL`, so
      embedded PGlite can never be used by mistake.
- [x] Los archivos de arranque Python históricos se han trasladado a `reference/python`; no se usan para desplegar el runtime TypeScript.

La primera URL es una demo académica/personal con datos sintéticos: Vercel Hobby y el subdominio gratuito del proveedor sustituyen la necesidad inicial de dominio o túnel Cloudflare. No se migran datos reales. Los créditos de DOCX conservan la identificación neutral MASCLI; no se atribuyen autores sin indicación del usuario.

### 2. Environment variables and secrets

Names only. Values live in the host's secret store or a root-only env file, never in git.

| Variable | Kind | Required | Notes |
| --- | --- | --- | --- |
| `MASCLI_DATA_KEY` | **secret** | yes | Base64 of 32 random bytes. It encrypts TOTP secrets, and losing it locks every MFA user out. Back it up separately from the database. |
| `MASCLI_DATABASE_URL` | **secret** | yes (production) | URL for the application role (§3). TLS is required unless the host is loopback. |
| `MASCLI_ADMIN_USERNAME` / `MASCLI_ADMIN_FULL_NAME` | config | first start | Bootstrap administrator on an empty installation only |
| `MASCLI_ADMIN_PASSWORD` | **secret** | first start only | At least 12 characters. Remove it from the environment after the first start. |
| `MASCLI_COOKIE_SECURE` | config | no | Leave unset or set `1`. **Never `0` on a public service.** |
| `MASCLI_HOST` / `MASCLI_PORT` | config | no | Bind to `127.0.0.1` behind the tunnel (default `127.0.0.1:8000`) |
| `MASCLI_TRUST_PROXY` | config | behind a proxy | Exactly `1` only when a trusted proxy sets `X-Forwarded-For`; it feeds login throttling per IP |
| `MASCLI_WEB_DIR` | config | yes | Built SPA directory |
| `MASCLI_MAX_UPLOAD_BYTES` | config | no | Default 10 MiB, ceiling 100 MiB |
| `MASCLI_STORAGE` | config | yes | `s3` for production; `local` only with a backed-up persistent disk |
| `MASCLI_UPLOAD_DIR` | config | `local` | Persistent directory outside the repository |
| `MASCLI_S3_ENDPOINT` / `MASCLI_S3_REGION` / `MASCLI_S3_BUCKET` | config | `s3` | HTTPS endpoint |
| `MASCLI_S3_ACCESS_KEY_ID` / `MASCLI_S3_SECRET_ACCESS_KEY` | **secret** | `s3` | Key scoped to this bucket only |
| `MASCLI_OLLAMA_URL` / `MASCLI_OLLAMA_EMBED_MODEL` | config | no | Semantic analysis. Without it, automatic mode falls back to rules. |
| `NODE_ENV` | config | yes | `production` |

ADR 0009 está integrado: configura `MASCLI_ALLOWED_HOSTS` con el host público. `MASCLI_REQUIRE_MFA` está activado por defecto; el administrador puede inscribir el autenticador en el primer acceso. Cada escritura exige `Origin` o `Referer`. La suite de paridad/cookies usa explícitamente MFA opcional; `03-mfa-required` comprueba por separado el alta obligatoria y el siguiente inicio de sesión.

### 3. PostgreSQL with a least-privilege role

PostgreSQL 16 or later. CI uses 17, and local verification used 16. Run this as a DBA once:

```sql
CREATE ROLE mascli_app LOGIN PASSWORD '<from secret store>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE mascli_tenant NOLOGIN NOINHERIT;      -- the migrations expect this name
GRANT mascli_tenant TO mascli_app WITH ADMIN OPTION;
CREATE DATABASE mascli OWNER mascli_app;
```

- The application must **not** be a superuser or have `BYPASSRLS`. Either one would bypass the
  forced row-level security that isolates tenants (ADR 0003). Tenant queries run as
  `mascli_tenant` through `SET LOCAL ROLE` inside `withTenant`.
- Creating `mascli_tenant` up front means the application role never needs `CREATEROLE`.
  Verified on PostgreSQL 16: a non-superuser role provisioned this way ran every migration and
  served `/health`.
- Require TLS to a managed or remote server. The adapter sets `ssl: 'require'` for non-loopback
  hosts. The pool holds 10 connections per process.

### 4. Schema migrations

Hand-written SQL migrations in `apps/api/src/platform/database/migrations/` run automatically at
API startup. A migration lock makes concurrent starts safe (real-PostgreSQL integration test).
There is no separate migrate command. The first start against an empty database creates the
schema, the bootstrap admin and the default tenant `MASCLI/PRJ-SECHURA`.

### 5. Legacy data migration (before the first API start)

Follow [data-migration.md](../migration/data-migration.md) end to end:

1. Back up the legacy SQLite files, `data/` configs and uploads, and back up the target database
   even when it is empty.
2. Run the migration **before the API starts for the first time**, against an empty database.
   The tool refuses a non-empty target. An API that has already started has bootstrapped an
   admin and a tenant, so restore the empty backup or re-create the database first. Do not use
   `--allow-non-empty` to get past that.
3. Dry run, apply, then verify (counts, record checksums, attachment sha256).
4. **Timestamps:** naive legacy timestamps are read as **UTC**. If the legacy server ran in
   another timezone (for example America/Lima, UTC−5), decide whether to shift them before
   applying. That decision is recorded in the runbook.
5. Sessions are not migrated. Every user signs in again, and migrated TOTP secrets keep working
   with the same `MASCLI_DATA_KEY`.
6. Start the API only after verify passes.

### 6. Object storage

- [ ] Use an S3-compatible bucket (for example Cloudflare R2) that is private, has versioning or
      lifecycle-based backup, and has a key limited to that bucket.
- [ ] Downloads are always proxied through `/system/uploads/:id/download` with tenant checks. Never
      make the bucket public or hand out presigned URLs.
- [ ] Known follow-up (L53): objects left behind after a record is deleted are not swept yet.
      Plan a periodic reconciliation.

### 7. Network exposure: Cloudflare Tunnel and Access

This is the route the user chose: a named tunnel from the host to Cloudflare, protected by
Cloudflare Access. It is **not** independent cloud hosting, so the machine and the API must stay
on.

- [ ] **Decision pending:** the Cloudflare account and the managed zone/hostname for MASCLI.
- [ ] Create a named tunnel with `cloudflared`. **Never** use a Quick Tunnel with real data.
      Route the public hostname to `http://127.0.0.1:8000` and keep the API bound to loopback.
- [ ] Protect the hostname with an Access application. Use an allow policy for named emails or
      an IdP group, a short session duration, and no bypass rules for `/`, `/api/*` or `/system/*`.
- [ ] Keep the public `Host` header (the cloudflared default). The API compares `Origin` with
      `Host` on writes.
- [ ] Set `MASCLI_TRUST_PROXY=1` only if cloudflared's `X-Forwarded-For` is confirmed during the
      rehearsal. Otherwise every client appears as `127.0.0.1` and shares one throttle bucket.
- [ ] HTTPS ends at Cloudflare's edge, so the browser sees HTTPS and the default Secure cookies
      work. Keep `MASCLI_COOKIE_SECURE` unset or `1`.
- [ ] Access is an extra layer on top of MASCLI's own sign-in and MFA. It does not replace them.

### 8. Backups and restore

- [ ] PostgreSQL: run a nightly `pg_dump -Fc` (or the provider's PITR), encrypt it, store it off
      the host, and keep it for a set period.
- [ ] Object storage: use bucket versioning or a replicated copy. Database rows and objects must
      be restorable to the same point, so take both backups in the same window.
- [ ] `MASCLI_DATA_KEY` and the role passwords go in a password manager or vault, separate from
      the dumps.
- [ ] **Restore drill before go-live:** restore into an empty database and bucket, start the API,
      and sign in with MFA. Then download an attachment and compare a `mascli-tenant.json` export.
      This has not been done yet.

### 9. Health checks and monitoring

- `GET /health` returns `{"status":"ok"}` without a session. It shows that the process is up and
  that migrations ran at boot. It does **not** query the database on each call, so pair it with a
  database check (for example `pg_isready`, or a monitored authenticated request).
- [ ] An external uptime monitor through the tunnel (Access service token) and process
      supervision (systemd `Restart=on-failure` or equivalent) with `SIGTERM` graceful shutdown.
      The API closes the server and then the pool.

### 10. Logging

- The API logs to stdout/stderr: the start line, the PGlite warning in development and
  unexpected errors (`console.error` in the error handler, with a generic 500 for the client).
  There is no per-request access log in the app. Cloudflare's dashboard and logs cover edge
  traffic.
- [ ] Capture stdout/stderr with journald or the platform's log collector, rotate them and
      restrict access. Logs must never contain passwords, TOTP secrets, session tokens or record
      payloads. The migration tool's redaction is test-asserted; the API's request logging is
      minimal by design.
- The tenant audit trail (`GET /system/audit`) is the business-level record of who changed what.

### 11. Rollback

- **Application:** keep the previous git revision and `apps/web/dist`. Stop the service, check
  out the previous revision, rebuild the web app and start again. Migrations are forward-only, so
  a rollback across a schema migration needs the database restore below.
- **Data:** restore the pre-deploy `pg_dump` and the matching bucket version.
- **Legacy cut-over:** the legacy installation is never modified (data-migration.md §6), so
  falling back means stopping the new API and starting the legacy app on its untouched data.
  Users sign in again.

## Not yet done / needs user decision

| Item | Status |
| --- | --- |
| Cloudflare account, zone and hostname | No requerido para la demo: se usa el subdominio gratuito de Vercel. |
| Alojamiento de la demo | Vercel Hobby, proyecto `mascli-demo-academica`, adaptador `apps/hosting`. |
| Créditos DOCX | Identificación neutral MASCLI, sin nombres personales inventados. |
| Controles ADR 0009 | Integrados en la consolidación TypeScript. |
| Migración de datos reales | Fuera del alcance de la demo académica: solo datos sintéticos. |
| Recursos de demo | Vercel y Blob privado creados; secretos bootstrap configurados. PostgreSQL gratuito pendiente de conexión. |
| Restore drill and an E2E run against the deployed URL | Not done |
| Publicación de demo | Autorizada por el usuario para uso académico/personal y datos sintéticos. Pendiente conexión de PostgreSQL y verificación de la URL; no autoriza migración real ni servicios de pago. |

## Not verifiable in the development environment

Cloudflare Tunnel/Access behaviour, real client IP forwarding, managed PostgreSQL TLS, S3/R2
credentials and permissions, restart persistence on the target host, and Safari/Firefox/real
mobile devices (the suite runs Chromium only, with a Pixel 7 profile for mobile).
