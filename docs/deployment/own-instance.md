# Your own SIPGES instance

This guide is for someone who forks SIPGES and wants to run it in **their own** GitHub, Neon and Cloudflare accounts. Every service is billed to you, and the code, the database and the evidence files stay in your accounts. Nothing in the repository points at anyone else's account: the values that differ per owner are GitHub variables and secrets that you set once.

[Versión en español](own-instance.es.md)

The deployment at `sipges.dreamcoder-dev08.workers.dev` is the repository owner's reference instance. You do not use it or need access to it.

## Quick path

1. Fork the repository and enable GitHub Actions on the fork.
2. Create the Neon database and role: [§2](#2-neon).
3. Create the Cloudflare resources and the API token: [§3](#3-cloudflare).
4. Put the Worker secrets in Cloudflare: [§4](#4-worker-secrets).
5. Set the GitHub variables and secrets: [§5](#5-github-variables-and-secrets).
6. Run **Deploy Workers** by hand and sign in: [§6](#6-first-deploy-and-first-sign-in).

Use synthetic data until you decide to load real records.

## 1. What you create, in your name

| Account or resource | Why | Who pays |
| --- | --- | --- |
| GitHub fork | Holds the code and runs CI and the deploy workflow | You (free tier or your plan) |
| Neon project | PostgreSQL with row-level security | You |
| Cloudflare account on the **Workers Paid** plan | The Worker, Hyperdrive and R2. The free plan allows 10 ms of CPU per request and a login costs about 250 ms | You |
| Hyperdrive configuration | The Worker reaches Neon only through it | Cloudflare account |
| R2 bucket `sipges-evidence` | Evidence files, private | Cloudflare account |
| `workers.dev` subdomain, or a custom domain | The public address | Cloudflare account |
| Cloudflare API token | Lets the deploy workflow publish | Cloudflare account |
| Google OAuth client (optional) | "Sign in with Google" for invited accounts | Google Cloud project |
| AI provider key, or an Ollama server (optional) | Analyst prose, semantic mode | The provider, or your server |

The Containers feature of the Paid plan is only needed for the optional Go trial Worker, which the normal deploy does not publish ([Go trial runbook](go-trial-runbook.md)).

## 2. Neon

1. Create a Neon project. Pick the region closest to your users.
2. Create the application role and database, as the project's owner role, with the SQL in [readiness §3](readiness.md#3-postgresql-with-a-least-privilege-role). The role must not be a superuser or have `BYPASSRLS`, or tenant isolation does not hold.
3. Copy two connection strings into your password manager, never into the repository:
   - the **direct** one (not the pooled one) with `sslmode=require`, for migrations: it becomes the GitHub secret `SIPGES_MIGRATION_DATABASE_URL`;
   - the same login, for Hyperdrive in the next step.

## 3. Cloudflare

Run these from `apps/hosting-cloudflare` after `pnpm install`:

```sh
pnpm exec wrangler login
pnpm exec wrangler hyperdrive create sipges --caching-disabled true \
  --connection-string "<the-neon-connection-string>"
pnpm exec wrangler r2 bucket create sipges-evidence
```

- `hyperdrive create` prints an **id** of 32 hexadecimal characters. That is `SIPGES_HYPERDRIVE_ID`. Keep Hyperdrive's query cache disabled: a cached read can keep a revoked session alive (the deploy re-asserts it every time).
- The Worker is called `sipges`, so its address is `https://sipges.<your-subdomain>.workers.dev`. Your workers.dev subdomain is shown in the Cloudflare dashboard under Workers & Pages. For a custom domain, add it to the Worker there and use that host name instead.
- API token: in the dashboard, My Profile → API Tokens → Create Token. Start from the "Edit Cloudflare Workers" template, limit it to your account, and make sure it can edit Workers scripts and Hyperdrive configurations. Add nothing else. The account id is on the dashboard overview.

## 4. Worker secrets

The Worker reads these at run time, so they live in Cloudflare, not in GitHub. Set them before the first deploy (`wrangler secret put <NAME>` asks for the value, so it never appears in your shell history):

| Name | Required | Value |
| --- | --- | --- |
| `SIPGES_DATA_KEY` | yes | 32 random bytes in base64, for example `openssl rand -base64 32`. Losing it makes encrypted fields unreadable: back it up with the database |
| `SIPGES_ADMIN_USERNAME`, `SIPGES_ADMIN_PASSWORD`, `SIPGES_ADMIN_FULL_NAME` | yes, for the first administrator | Used only while the database has no accounts |
| `SIPGES_GOOGLE_CLIENT_ID`, `SIPGES_GOOGLE_CLIENT_SECRET`, `SIPGES_GOOGLE_ADMIN_EMAIL` | no | Google sign-in. Authorised redirect URI: `https://<your-host>/auth/google/callback` |
| `SIPGES_ANALYST_PROVIDER`, `ANTHROPIC_API_KEY` | no | Off by default. It sends non-restricted briefing text to the provider, so enable it only with the data owner's approval |
| `SIPGES_OLLAMA_URL` | no | An address the Worker can reach over HTTPS. The local default `127.0.0.1:11434` does not exist on Workers |

Without `SIPGES_DATA_KEY` the Worker does not start, and without the administrator values an empty database has no first account. If `wrangler secret put` offers to create the Worker `sipges`, accept. The remaining variables and what each does are in [Cloudflare Workers §2](cloudflare-workers.md#2-set-variables-and-secrets).

## 5. GitHub variables and secrets

In the fork: Settings → Secrets and variables → Actions.

**Repository variables** (Variables tab). The deploy stops before building with `Missing GitHub Actions variable <NAME>: see docs/deployment/own-instance.md` if one is missing.

| Name | Value | Where it comes from |
| --- | --- | --- |
| `SIPGES_PUBLIC_HOST` | `sipges.<your-subdomain>.workers.dev`, or your custom host. No `https://`, no path | §3 |
| `SIPGES_HYPERDRIVE_ID` | 32 hexadecimal characters | Printed by `hyperdrive create` in §3 |
| `SIPGES_RUNS_ON` | Optional. A JSON list of runner labels, such as `["self-hosted"]`. Unset uses GitHub's runners | [CI runner](../operations/ci-runner.md) |

**Secrets**, in the environment called `production` (Settings → Environments → New environment, then add them there):

| Name | Value | Where it comes from |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token | §3 |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id | §3 |
| `SIPGES_MIGRATION_DATABASE_URL` | Direct Neon URL with `sslmode=require` | §2 |

Two more names exist only for the optional Go trial, which you deploy by hand and not through GitHub: `SIPGES_GO_PUBLIC_HOST` and `SIPGES_GO_HYPERDRIVE_ID` (see the [runbook](go-trial-runbook.md)). Leave them unset otherwise.

## 6. First deploy and first sign-in

1. Make sure CI is green on your `main`. **Deploy Workers** starts by itself after CI succeeds on a push to `main`.
2. For the first run, open Actions → Deploy Workers → Run workflow, branch `main`.
3. The job checks the variables, builds, applies the migrations, deploys and smoke-tests `/health/ready`. If the smoke test fails it rolls back; on the very first deploy there is no earlier version to return to, so read the log and fix the cause.
4. Open `https://<your-host>`. Sign in with the administrator from §4. MFA is required by default: enrol your authenticator at the first sign-in.
5. Create a project, then invite people from inside the app.

## Costs

SIPGES adds no fee of its own. You pay each vendor under your own plan; check their current prices before you start:

- Cloudflare: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Containers](https://developers.cloudflare.com/containers/pricing/) if you try Go.
- Neon: [pricing](https://neon.com/pricing).
- GitHub Actions: [GitHub plans](https://github.com/pricing).
- Anthropic, only if you enable it: [pricing](https://www.anthropic.com/pricing).

The Worker also runs a cron every 15 minutes, which counts toward Workers usage.

## Update from the original repository

```sh
git remote add upstream <url-of-the-original-repository>   # once
git fetch upstream
git switch main
git merge upstream/main
git push origin main
```

Resolve conflicts in your fork, let CI pass, and the deploy runs on its own. Migrations are additive and run before the new code goes live. Your variables and secrets stay in your accounts, so a merge never changes them.

## Local development

`pnpm --filter @sipges/hosting-cloudflare dev` runs `wrangler dev` with the committed defaults (host `localhost`, a placeholder Hyperdrive id); point it at a local PostgreSQL with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`. The deploy writes `wrangler.deploy.jsonc` from your variables; it is git-ignored.

## Where your data lives

Records sit in your Neon project, evidence files in your R2 bucket, and secrets in your Cloudflare and GitHub accounts. The repository holds no data and no account value. To stop being billed, delete the Worker, the Hyperdrive configuration and the R2 bucket in Cloudflare, and the project in Neon.
