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
pnpm exec wrangler hyperdrive create mascli --connection-string "<postgres-url-with-sslmode=require>"
pnpm exec wrangler r2 bucket create mascli-evidence
```

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

## 3. Build and deploy

```sh
pnpm --filter @mascli/hosting-cloudflare build   # SPA into ./public + migration index
pnpm --filter @mascli/hosting-cloudflare bundle  # dry run: bundle size and bindings
pnpm exec wrangler deploy                        # only with the owner's go-ahead
```

Migrations run on the first request of each isolate, from the bundled SQL files.

## 4. Check the deployment

1. `GET /health` returns 200 on the public host and 400 (`Host no permitido`) on any other host.
2. The SPA loads with MASCLI's CSP header (no inline scripts).
3. Sign in, enrol MFA, open the territorial map and upload one evidence file (lands in R2).
4. `wrangler tail` shows the 15-minute Cron Trigger completing without errors.

## Rolling back

Point the domain back to the Vercel deployment; both runtimes share the database and schema,
so no data step is needed. Evidence uploaded to R2 while Workers served traffic must be copied
to the Node storage before switching back.
