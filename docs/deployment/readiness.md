# Deployment readiness (T14)

Registro histórico de la demo, 2026-10-14 (el host Vercel se retiró; véase [ADR 0029](../adr/0029-retire-vercel-host.md)): el propietario solicitó acceso sencillo con datos sintéticos. La configuración documentada de Vercel usaba `SIPGES_REQUIRE_MFA=0`; se comprobaron login con contraseña, dashboard, administración, recarga y logout. Esa actualización sustituyó la inscripción MFA pendiente de la prueba anterior, solo para esa demo. El smoke público de CRUD/Blob/PDF/DOCX seguía pendiente. No se repitieron solicitudes públicas ni se consultó la configuración desplegada para esta candidata. Véase [la comprobación fechada](../history/public-demo-verification.md).

This is the checklist for putting the TypeScript SIPGES (`apps/api` serving the built
`apps/web`) in front of users. Dated demo evidence, current local candidate checks and
institutional acceptance are separate. The documented demo used Vercel (since retired, ADR 0029), private Blob and the
owner's Neon integration with synthetic data only; it is not evidence that this candidate is
deployed or approved for real data. Institutional MFA recommendations and the runtime's
secure default remain unchanged. No real-data migration or newly acquired domain is claimed.

Related documents: [workspace and configuration](../migration/workspace.md),
[legacy data migration runbook](../migration/data-migration.md),
[secure cookies](../secure-cookies.md), [web delivery and CSP](../migration/web.md),
[ADRs](../adr/README.md) and the original
[secure public deployment plan](../../odd/archive/secure-sipges-public-deployment.md).

## Hosting direction: Cloudflare Workers is the only host

Cloudflare Workers is the only SIPGES host (ADR 0028; the Vercel host was retired in
[ADR 0029](../adr/0029-retire-vercel-host.md)). The
[Workers investigation](../../odd/archive/cloudflare-workers.md) was deferred (L14) because
`hash-wasm` compiles WebAssembly at run time, which workerd rejects, and then resumed (L16) with a
plain-JavaScript password hasher (`@noble/hashes`, T6). Inside workerd that hasher hashes and
verifies new, native and legacy hashes with WebAssembly compilation still disabled (L17); the
Hyperdrive connection and migrations already passed after a binding-only TLS correction.
The reference instance, the repository owner's own deployment, runs at `https://sipges.dreamcoder-dev08.workers.dev`; a fork deploys its own with its own accounts ([own-instance guide](own-instance.md)). It runs against a Neon database through
Hyperdrive and holds no real data (ODD L22). The end-to-end suite against `wrangler dev`
(T4) passes locally (93 passed, 1 optional skip; L20) and the steps are in the
[Workers deployment guide](cloudflare-workers.md).

The existing serial Node/Chromium E2E suite (`pnpm e2e`, job-6) completed with exit 0:
**93 passed, 1 skipped**. It built the SPA and used isolated synthetic PGlite state, with
temporary files inside the repository. The skipped case is the optional mobile screenshot
capture (`SIPGES_E2E_SCREENSHOT_DIR` was unset). Local ignored evidence:
`odd/evidence/cloudflare-workers/node-readiness-U8eOId1G/node-e2e.log` and its adjacent
`node-e2e.exit`; these artifacts are not distributed with a fresh clone.
The run started from HEAD `f582ebb` with uncommitted Worker diagnostics; unrelated UI and
dependency changes were visible afterward. This is evidence for that observed run, not an
immutable certification of the complete current working tree.

No deployed revision, host configuration, Neon/Blob access, restore capability or institutional
acceptance was verified by this local run. GitHub CI was previously blocked by account billing;
its current status was not rechecked here. The owner must resolve the account-level issue.

## Current local candidate, not production acceptance

The [production-candidate ODD](../../odd/archive/production-candidate.md) records the isolated
code slice `4a4b5f0` → `2ba2b5a` and [its synthetic HTTP differential](../../odd/evidence/production-candidate/comparison.json).

- Lint, format, architecture boundaries and six workspace typechecks passed. The complete
  API run passed 696 tests, with 14 skipped (99 files passed, five skipped). Optional
  PostgreSQL-server integration was not run without an authorized synthetic connection.
- Seven public GET responses matched the base byte-for-byte; anonymous/ungranted requests
  retained exact 401/403 responses and did not change public records/counters. Dashboard
  SQL row-array materialization fell 84.54%; short serial timings are diagnostic, not load proof.
- Independent static security review found no blocker. It did not independently run tests.
  Native review assessment remains unavailable because of undeclared untracked files, even
  for the committed range; no native authority, reviewDue result or approval was established.
- No new browser run, aggregate `pnpm verify`, remote CI or public deployment smoke is claimed
  for this slice. Prior browser/demo evidence remains tied to its original revision.
- `reference/python` is a behavioral/parity reference outside the deployed TypeScript runtime.
  Migration/import tools remain useful for separately authorized data work. Neither is
  redundant merely because the runtime moved to TypeScript; no legacy deletion was performed.

## Required gates before a deploy

| Gate | Command | Covers |
| --- | --- | --- |
| Static checks and unit/HTTP tests | `pnpm check` (CI job `typescript`) | Lint, format, architecture boundaries, types, API/web/kernel tests; optional real-PostgreSQL integration when `SIPGES_TEST_DATABASE_URL` is set |
| End-to-end parity | `pnpm e2e` (CI job `e2e`) | Real API + built SPA in headless Chromium against a throwaway database, see below |
| Data migration rehearsal | `pnpm --filter @sipges/api migrate:legacy` dry run / verify | Synthetic fixture in tests; a real dry run is a deploy-day step |

### End-to-end suite (`apps/e2e`)

`pnpm e2e` builds the SPA and runs Playwright (pinned `@playwright/test`, Chromium only). The
global setup starts `apps/api/src/main.ts` with `SIPGES_WEB_DIR=apps/web/dist`, a fresh PGlite
directory (or, when `SIPGES_E2E_DATABASE_URL` names a PostgreSQL server, a database it creates and
drops) and an admin password and data key generated for that run. No credential is committed or
written to disk. Every test fails on any CSP violation, page error or unexpected console error.

| Spec | Behaviour (S7 parity unless noted) |
| --- | --- |
| `01-auth-mfa` | Wrong/right password; HttpOnly + Secure + SameSite=Strict 8 h session cookie; same-app redirect after sign-in and foreign redirect ignored; sign-out revokes the token server-side; TOTP enrollment from the UI with an independent RFC 6238 authenticator, wrong code refused, **re-enrollment refused with 409** (enrollment guard), password-only login then asks for the code, next code accepted, replayed code refused |
| `02-cookie-policy` | `SIPGES_COOKIE_SECURE` unset and `1` send `Secure` and Chromium keeps **no** session over plain HTTP on a non-loopback name; exactly `0` drops `Secure` on both session and project cookies; `''`, `true`, `yes`, `01`, ` 1`, `2` stop startup before any resource opens |
| `03-tenancy` | Second tenant created from the admin screen; project switch is server-side (cookie-only request sees the new scope, survives reload, no `localStorage`); records never cross projects in the UI; foreign record/attachment ids give **404** in another granted tenant; a user without the grant gets **403** for header scope, query `project_id`, body `project_id`/`Proyecto_ID`, `/select-project` and export; **`sipges-tenant.json`** export contains only the active tenant and no identity material (S8) |
| `04-records-evidence` | Fuentes CRUD (create, view, edit keeping evidence links, delete with cancel/confirm), evidence upload and byte-identical download, event creation and search, demands/commitments toggle |
| `05-analysis-management` | IRSA snapshot saved to history; situational, strategic, consensus and integrated DOCX downloads (ZIP signature); document lab analysis (SHA-256 shown), DOCX report and candidates sent to the review inbox; management CSV scoped to the project |
| `06-csp-screens` | SPA CSP header has no `unsafe-*`; shell has no inline script/style/handlers; injected inline script and inline handler are blocked and reported; all 18 screens render with no CSP report |
| `mobile` (Pixel 7 profile) | Sign-in, menu toggle with `aria-expanded` and Escape, navigation focus, and no horizontal page scroll on every screen |

The suite found one real defect, now fixed: Zod 4 probed `new Function` on first parse, which a
strict CSP reports as a `script-src` violation. `apps/web/src/shared/config/zod.ts` turns on
jitless parsing before any schema runs.

Local run: `pnpm install --frozen-lockfile`, then `pnpm e2e`. If the browser is missing, run
`pnpm --filter @sipges/e2e exec playwright install chromium` once. To use PostgreSQL, set
`SIPGES_E2E_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/postgres`. The role must be
able to create databases. A database named `sipges_e2e_<random>` is created and dropped.

## Pre-deployment checklist

> **Historical sections.** Production runs only on Cloudflare Workers (ADR 0028,
> [ADR 0029](../adr/0029-retire-vercel-host.md)); Node runs SIPGES only for development and tests.
> The parts below that assume a self-hosted Node process (§1 Runtime, §7 Cloudflare Tunnel and
> Access, process supervision in §9, journald in §10 and the application rollback in §11) are kept
> as a record and apply only if a future institutional host is chosen. For the Worker, follow the
> [Workers deployment guide](cloudflare-workers.md); secrets, incidents and backups are in the
> [handover guide](../operations/handover.md).

### 1. Runtime (historical: self-hosted Node)

For the Worker, see the [Workers deployment guide](cloudflare-workers.md) instead.

- [ ] Node.js 22 or later on the host. Node 24 is recommended. The API runs `.ts` files directly
      with type stripping, so it has no build step: `node apps/api/src/main.ts`.
- [ ] `pnpm install --frozen-lockfile` and `pnpm --filter @sipges/web build`. Then
      `SIPGES_WEB_DIR` points at `apps/web/dist`.
- [ ] `NODE_ENV=production`. With it, the API refuses to start without `SIPGES_DATABASE_URL`, so
      embedded PGlite can never be used by mistake.
- [x] Los archivos de arranque Python históricos se han trasladado a `reference/python`; no se usan para desplegar el runtime TypeScript.

La primera URL fue una demo académica/personal con datos sintéticos: el subdominio gratuito `workers.dev` de Cloudflare sustituye la necesidad inicial de un dominio propio o un túnel Cloudflare. **Histórico (hasta la 1.0.0):** desde el PR #49 (migración 0019) se retiró el caso sintético y la base guarda la información real del proyecto ([CHANGELOG](../../CHANGELOG.md)); las pruebas siguen usando solo datos sintéticos. Los créditos de DOCX conservan la identificación neutral SIPGES; no se atribuyen autores sin indicación del usuario.

### 2. Environment variables and secrets

Names only. Values live in the host's secret store or a root-only env file, never in git.

| Variable | Kind | Required | Notes |
| --- | --- | --- | --- |
| `SIPGES_DATA_KEY` | **secret** | yes | Base64 of 32 random bytes. It encrypts TOTP secrets, and losing it locks every MFA user out. Back it up separately from the database. |
| `SIPGES_DATABASE_URL` | **secret** | yes (production) | URL for the application role (§3). TLS is required unless the host is loopback. |
| `SIPGES_ADMIN_USERNAME` / `SIPGES_ADMIN_FULL_NAME` | config | first start | Bootstrap administrator on an empty installation only |
| `SIPGES_ADMIN_PASSWORD` | **secret** | first start only | At least 12 characters. Remove it from the environment after the first start. |
| `SIPGES_COOKIE_SECURE` | config | no | Leave unset or set `1`. **Never `0` on a public service.** |
| `SIPGES_HOST` / `SIPGES_PORT` | config | no | Bind to `127.0.0.1` behind the tunnel (default `127.0.0.1:8000`) |
| `SIPGES_TRUST_PROXY` | config | behind a proxy | Exactly `1` only when a trusted proxy sets `X-Forwarded-For`; it feeds login throttling per IP |
| `SIPGES_WEB_DIR` | config | yes | Built SPA directory |
| `SIPGES_MAX_UPLOAD_BYTES` | config | no | Default 10 MiB, ceiling 100 MiB |
| `SIPGES_STORAGE` | config | yes | `s3` for production; `local` only with a backed-up persistent disk |
| `SIPGES_UPLOAD_DIR` | config | `local` | Persistent directory outside the repository |
| `SIPGES_S3_ENDPOINT` / `SIPGES_S3_REGION` / `SIPGES_S3_BUCKET` | config | `s3` | HTTPS endpoint |
| `SIPGES_S3_ACCESS_KEY_ID` / `SIPGES_S3_SECRET_ACCESS_KEY` | **secret** | `s3` | Key scoped to this bucket only |
| `SIPGES_OLLAMA_URL` / `SIPGES_OLLAMA_EMBED_MODEL` | config | no | Semantic analysis. Without it, automatic mode falls back to rules. |
| `SIPGES_ANALYST_PROVIDER` / `SIPGES_ANALYST_MODEL` / `ANTHROPIC_API_KEY`, or `SIPGES_ANALYST_BASE_URL` / `SIPGES_ANALYST_API_KEY` with `openai-compatible` | config + secret | no | Optional prose for analyst briefings (ADR 0013). Off by default; sends non-restricted briefing text to the configured provider (Anthropic or any OpenAI-compatible endpoint such as DeepSeek, OpenAI or a local Ollama), so enable an external provider only with the data owner's approval. Without it, briefings stay extractive. |
| `NODE_ENV` | config | yes | `production` |

ADR 0009 está integrado: configura `SIPGES_ALLOWED_HOSTS` con el host público. `SIPGES_REQUIRE_MFA` está activado por defecto; el administrador puede inscribir el autenticador en el primer acceso. Cada escritura exige `Origin` o `Referer`. La suite de paridad/cookies usa explícitamente MFA opcional; `03-mfa-required` comprueba por separado el alta obligatoria y el siguiente inicio de sesión.

### 3. PostgreSQL with a least-privilege role

PostgreSQL 16 or later. CI uses 17, and local verification used 16. Run this as a DBA once:

```sql
CREATE ROLE sipges_app LOGIN PASSWORD '<from secret store>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE sipges_tenant NOLOGIN NOINHERIT;      -- the migrations expect this name
CREATE ROLE mascli_tenant NOLOGIN NOINHERIT;      -- migration 0003 still names it; 0030 empties it
GRANT sipges_tenant, mascli_tenant TO sipges_app WITH ADMIN OPTION;
CREATE DATABASE sipges OWNER sipges_app;
```

- The application must **not** be a superuser or have `BYPASSRLS`. Either one would bypass the
  forced row-level security that isolates tenants (ADR 0003). Tenant queries run as
  `sipges_tenant` through `SET LOCAL ROLE` inside `withTenant`. The Go API refuses such a role:
  it exits at start, and refuses every new connection when the server only answers later.
  `SIPGES_ALLOW_PRIVILEGED_DB_ROLE=1` exists for synthetic test servers and works on loopback
  only.
- Creating both roles up front means the application role never needs `CREATEROLE`.
  Verified on PostgreSQL 16: a non-superuser role provisioned this way ran every migration and
  served `/health`.
- Require TLS to a managed or remote server. The adapter sets `ssl: 'require'` for non-loopback
  hosts. The pool holds 10 connections per process.

### 4. Schema migrations

Hand-written SQL migrations in `apps/api/src/platform/database/migrations/` run automatically at
API startup. A migration lock makes concurrent starts safe (real-PostgreSQL integration test).
There is no separate migrate command. The first start against an empty database creates the
schema, the bootstrap admin and the default tenant `SIPGES/PRJ-SECHURA`.

### 5. Legacy data migration (future institutional deployment)

No aplicaba a la demo académica de octubre, que usaba datos sintéticos (hoy la base guarda la información real del proyecto, véase arriba). Para una futura migración institucional autorizada, follow [data-migration.md](../migration/data-migration.md) end to end:

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
   with the same `SIPGES_DATA_KEY`.
6. Start the API only after verify passes.

### 6. Object storage

- [ ] Use an S3-compatible bucket (for example Cloudflare R2) that is private, has versioning or
      lifecycle-based backup, and has a key limited to that bucket.
- [ ] Downloads are always proxied through `/system/uploads/:id/download` with tenant checks. Never
      make the bucket public or hand out presigned URLs.
- [ ] Known follow-up (L53): objects left behind after a record is deleted are not swept yet.
      Plan a periodic reconciliation.

### 7. Network exposure: Cloudflare Tunnel and Access (historical: self-hosted Node)

Esta alternativa queda para un futuro alojamiento institucional. La demo actual usa Cloudflare Workers
y su URL `workers.dev`; no requiere dominio ni túnel Cloudflare. Los pasos siguientes
solo aplican si se elige posteriormente esa alternativa.

- [ ] **Solo para esa alternativa futura:** elegir cuenta Cloudflare y zona/hostname.
- [ ] Create a named tunnel with `cloudflared`. **Never** use a Quick Tunnel with real data.
      Route the public hostname to `http://127.0.0.1:8000` and keep the API bound to loopback.
- [ ] Protect the hostname with an Access application. Use an allow policy for named emails or
      an IdP group, a short session duration, and no bypass rules for `/`, `/api/*` or `/system/*`.
- [ ] Keep the public `Host` header (the cloudflared default). The API compares `Origin` with
      `Host` on writes.
- [ ] Set `SIPGES_TRUST_PROXY=1` only if cloudflared's `X-Forwarded-For` is confirmed during the
      rehearsal. Otherwise every client appears as `127.0.0.1` and shares one throttle bucket.
- [ ] HTTPS ends at Cloudflare's edge, so the browser sees HTTPS and the default Secure cookies
      work. Keep `SIPGES_COOKIE_SECURE` unset or `1`.
- [ ] Access is an extra layer on top of SIPGES's own sign-in and MFA. It does not replace them.

### 8. Backups and restore

- [ ] PostgreSQL: run a nightly `pg_dump -Fc` (or the provider's PITR), encrypt it, store it off
      the host, and keep it for a set period.
- [ ] Object storage: use bucket versioning or a replicated copy. Database rows and objects must
      be restorable to the same point, so take both backups in the same window.
- [ ] `SIPGES_DATA_KEY` and the role passwords go in a password manager or vault, separate from
      the dumps.
- [ ] **Restore drill before go-live:** restore into an empty database and bucket, start the API,
      and sign in with MFA. Then download an attachment and compare a `sipges-tenant.json` export.
      This has not been done yet.

### 9. Health checks and monitoring

- `GET /health` returns `{"status":"ok"}` without a session. It shows that the process is up and
  that migrations ran at boot. It does **not** query the database on each call, so pair it with a
  database check (for example `pg_isready`, or a monitored authenticated request).
- [ ] An external uptime monitor through the tunnel (Access service token) and process
      supervision (systemd `Restart=on-failure` or equivalent) with `SIGTERM` graceful shutdown.
      The API closes the server and then the pool. *Historical (self-hosted Node): on Workers,
      the deploy workflow smoke-tests `/health` and Cloudflare runs the process.*

### 10. Logging

- The API logs to stdout/stderr: the start line, the PGlite warning in development and
  unexpected errors (`console.error` in the error handler, with a generic 500 for the client).
  Structured per-request access logging is enabled by `SIPGES_ACCESS_LOG` (default on),
  through `platform/http/observability.ts`. It records method, matched route, request path,
  status and duration, without query strings, request bodies or cookies. A path can contain
  record identifiers: restrict log access and retention. Edge-provider logs are separate and
  do not replace application logs.
- [ ] *Self-hosted Node only (historical):* capture stdout/stderr with journald or the platform's log collector, rotate them and
      restrict access. Logs must never contain passwords, TOTP secrets, session tokens or record
      payloads. The migration tool's redaction is test-asserted; the API's request logging is
      minimal by design.
- The tenant audit trail (`GET /system/audit`) is the business-level record of who changed what.

### 11. Rollback (historical: self-hosted Node)

On Workers, roll back as described in the [Workers guide](cloudflare-workers.md#rolling-back).

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
| Cloudflare zone and hostname | No requerido para la demo: se usa el subdominio `workers.dev`. |
| Alojamiento de la demo | Cloudflare Workers (Hyperdrive + Neon, R2), adaptador `apps/hosting-cloudflare`. Vercel se retiró (ADR 0029). |
| Créditos DOCX | Identificación neutral SIPGES, sin nombres personales inventados. |
| Controles ADR 0009 | Integrados en la consolidación TypeScript. |
| Migración de datos reales | Fuera del alcance de la demo académica: solo datos sintéticos. |
| Recursos de demo | Worker, Hyperdrive y R2 privado; PostgreSQL Neon vinculado por el propietario. La base `neondb` de la demo Vercel se conserva en Neon como respaldo, sin migrar. |
| Restore drill and an E2E run against the deployed URL | Not done |
| Operator inputs for the remaining gates | Not authorizations by themselves: (1) an explicitly synthetic, least-privilege PostgreSQL connection for the server integration run; (2) a disposable restore environment with coordinated database/object backups and key scope; (3) institutional identity, storage and monitoring owners, plus the external-acceptance owners already named in the [production-candidate ODD](../../odd/archive/production-candidate.md); (4) a separate delivery/activation decision. No gate in these rows is closed and the candidate is not declared production-ready. |
| Publicación de demo | Evidencia histórica del 2026-10-14: acceso sin inscripción MFA obligatoria por decisión del propietario; no es una excepción institucional. Smoke público CRUD/Blob/PDF/DOCX pendiente en esa evidencia. No se verificó de nuevo ni se publicó esta candidata. |

## Not verifiable in the development environment

Cloudflare Tunnel/Access behaviour, real client IP forwarding, managed PostgreSQL TLS, S3/R2
credentials and permissions, restart persistence on the target host, and Safari/Firefox/real
mobile devices (the suite runs Chromium only, with a Pixel 7 profile for mobile).
