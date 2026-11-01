# Deploying MASCLI on Cloudflare Workers

How to publish MASCLI with the Workers adapter (`apps/hosting-cloudflare`, ADR 0028). Nothing
here has been run against a Cloudflare account: every step below needs the owner's account and
explicit go-ahead. The local verification it relies on is in `odd/tasks/cloudflare-workers.md`
(L17, L20).

## Before you start

| Need | Why |
| --- | --- |
| Workers **Paid** plan | Free allows 10 ms of CPU per request; a login costs ~250 ms (Argon2id). |
| PostgreSQL with row-level security (Neon) | The same database the Node build uses; D1 is not supported. |
| A Hyperdrive configuration pointing at it | The Worker reaches PostgreSQL only through the `HYPERDRIVE` binding. |
| A private R2 bucket | Evidence files (`EVIDENCE` binding); never made public. |
| The public host name | `MASCLI_ALLOWED_HOSTS`; the Worker refuses to start without it. |

Use synthetic data until the owner approves a real-data migration.

## 1. Create the resources

```sh
cd apps/hosting-cloudflare
pnpm exec wrangler login
pnpm exec wrangler hyperdrive create mascli --caching-disabled true \
  --connection-string "<postgres-url-with-sslmode=require>"
pnpm exec wrangler r2 bucket create mascli-evidence
```

Keep Hyperdrive's query cache **disabled**: it caches reads outside transactions by text and
parameters, which in MASCLI are the global tables (accounts, sessions, grants, API keys). A cached
read can keep a revoked session or key alive and shows writes up to a minute late. Tenant reads
run inside `withTenant` transactions, which Hyperdrive never caches.

Put the Hyperdrive id printed by the first command in `wrangler.jsonc`
(`REPLACE_WITH_HYPERDRIVE_CONFIG_ID`). Never commit the connection string.

## 2. Set variables and secrets

Secrets go through `wrangler secret put <NAME>`; plain values can go in `vars`.

| Name | Kind | Value |
| --- | --- | --- |
| `MASCLI_ALLOWED_HOSTS` | var | Public host(s), comma separated |
| `MASCLI_DATA_KEY` | secret | 32 random bytes, base64 (the same key as the database's existing data) |
| `MASCLI_ADMIN_USERNAME`, `MASCLI_ADMIN_PASSWORD`, `MASCLI_ADMIN_FULL_NAME` | secret | First administrator, only for an empty database |
| `MASCLI_REQUIRE_MFA`, `MASCLI_COOKIE_SECURE` | var | Leave unset: both default to `1` (MFA required, HTTPS-only cookies) |
| `MASCLI_CRON_SCHEDULE` | var | Optional; defaults to `*/15 * * * *`, must match `triggers.crons` |
| Google sign-in, VAPID push, Ollama/analyst | secret/var | As in the Node build, only if used |

The Worker sets `NODE_ENV=production`, the database URL (from Hyperdrive), the upload directory
(unused, R2 replaces it) and turns the in-process automation timer off; do not set those.

## 3. Build, migrate and deploy

Deploys are automatic: when the `CI` workflow succeeds on a push to `main`, the
`Deploy Workers` workflow (`.github/workflows/deploy-workers.yml`) checks out that exact
commit, builds, applies the migrations, runs `deploy:worker` and smoke-tests `/health`. It can
also be started by hand (`workflow_dispatch`, `main` only) and runs one at a time. Define these
secrets on the GitHub `production` environment:

| Secret | Value |
| --- | --- |
| `MASCLI_MIGRATION_DATABASE_URL` | Direct Neon URL (not Hyperdrive) with `sslmode=require` |
| `CLOUDFLARE_API_TOKEN` | Token allowed to edit Workers and Hyperdrive |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account id |

Manual run, with the owner's go-ahead:

```sh
pnpm --filter @mascli/hosting-cloudflare build   # SPA into ./public + migration index
pnpm --filter @mascli/hosting-cloudflare bundle  # dry run: bundle size and bindings
MASCLI_MIGRATION_DATABASE_URL="<direct-url>" pnpm --filter @mascli/hosting-cloudflare migrate
pnpm --filter @mascli/hosting-cloudflare run deploy:worker  # only with the owner's go-ahead
```

`deploy:worker` turns Hyperdrive query caching off before every deploy, so a cache switched on
in the dashboard cannot serve stale accounts, sessions or grants; a test pins the script to the
Hyperdrive id in `wrangler.jsonc`. If you change the id, update both. Deploy only through
`deploy:worker`: a plain `wrangler deploy` skips the guard, and the cache state is re-asserted
only at deploy time, not while the Worker runs.

Migrations no longer run in the Worker: `migrate.mjs` applies them (advisory lock, one
transaction each) before the new code goes live. A request that finds migrations pending gets
503 and logs the pending versions, so always run `migrate` before `deploy:worker`. Migrations
must stay compatible with the version still serving while the deploy finishes.

## 4. Check the deployment

1. `GET /health` returns 200 on the public host. On `workers.dev`, Cloudflare's edge already
   answers 403 for a foreign host; a foreign host that reaches the Worker (custom domain or
   route) gets 400 (`Host no permitido`).
2. The SPA loads with MASCLI's CSP header (no inline scripts).
3. Sign in, enrol MFA, open the territorial map and upload one evidence file (lands in R2).
4. `wrangler tail` shows the 15-minute Cron Trigger completing without errors.

## Rolling back

Point the domain back to the Vercel deployment; both runtimes share the database and schema,
so no data step is needed. Evidence uploaded to R2 while Workers served traffic must be copied
to the Node storage before switching back.
