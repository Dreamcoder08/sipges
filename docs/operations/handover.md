# Operations handover

Who holds which access, where every secret lives, what to do when something breaks, and how to
back up and restore SIPGES. Production is one Cloudflare Worker (ADR 0028,
[ADR 0029](../adr/0029-retire-vercel-host.md)) at `https://sipges.dreamcoder-dev08.workers.dev`,
with Neon PostgreSQL through Hyperdrive and evidence files in R2.

> **Names only.** This guide never holds a secret value, and neither may any edit of it. Values
> live in the stores named below.

Status words used here: **verified** means checked against this repository; **not verifiable
here** means it depends on an external console that the repository does not record.

## Quick path

| Situation | Go to |
| --- | --- |
| A new operator takes over | [Access matrix](#access-matrix), then [Secrets](#secrets-and-rotation) |
| The last deploy broke production | [Bad deploy](#bad-deploy) |
| A secret or key leaked | [Leaked key](#leaked-key-or-secret) |
| `SIPGES_DATA_KEY` is lost | [Lost data key](#lost-sipges_data_key) |
| Data must be recovered | [Backup and restore](#backup-and-restore) |

## Access matrix

| Service | What it holds | Who needs access | Source |
| --- | --- | --- | --- |
| GitHub `Dreamcoder08/sipges` (private) | Code, CI (`.github/workflows/ci.yml`), deploys (`deploy-workers.yml`), the `production` environment secrets | Owner (admin); maintainers (write) | Verified: workflows in the repo |
| Cloudflare account (`dreamcoder-dev08.workers.dev`) | Worker `sipges`, its secrets, Hyperdrive config `9eae2c5e3d614feca42b525fc82e10e1`, private R2 bucket `sipges-evidence`, 15-minute Cron Trigger | Owner; whoever deploys by hand | Verified: `apps/hosting-cloudflare/wrangler.jsonc` |
| Vercel account → Neon project `neon-aero-brush` | The production database (and the old `neondb` backup). Created through Vercel's Neon integration and billed via Vercel | Owner only | ADR 0029. **Removing the Vercel account or its Neon integration deletes the database.** |
| Google Cloud project with the OAuth client | «Entrar con Google»; consent screen in Testing mode, redirect `/auth/google/callback` | Owner | `odd/tasks/cloudflare-workers.md` L22; current console state not verifiable here |
| SIPGES itself | Accounts, roles, project grants, MCP/webhook API keys (Integraciones) | Administrators inside the app | Verified: identity and integration contexts |

Grant the smallest role that does the job, and remove access when someone leaves: GitHub
collaborator, Cloudflare member, SIPGES account (deactivating an account also deletes its
sessions, verified in `sql-identity-store.ts`).

## Secrets and rotation

### Where each secret lives

| Name | Store | Used for |
| --- | --- | --- |
| `SIPGES_DATA_KEY` | Worker secret | Encrypts TOTP secrets (AES-256-GCM, ADR 0004); derives the per-project pseudonym keys (ADR 0030) |
| `SIPGES_ADMIN_USERNAME`, `SIPGES_ADMIN_PASSWORD`, `SIPGES_ADMIN_FULL_NAME` | Worker secret | First administrator, only on an empty database |
| `SIPGES_GOOGLE_CLIENT_ID`, `SIPGES_GOOGLE_CLIENT_SECRET`, `SIPGES_GOOGLE_ADMIN_EMAIL` | Worker secret | Google sign-in |
| `SIPGES_VAPID_PUBLIC_KEY`, `SIPGES_VAPID_PRIVATE_KEY`, `SIPGES_VAPID_SUBJECT` | Worker secret, only if push is used | Browser push (ADR 0014) |
| `ANTHROPIC_API_KEY` | Worker secret, **not set** (ai-egress-privacy L2) | Optional analyst narrator |
| `SIPGES_ALLOWED_HOSTS` | `vars` in `wrangler.jsonc` (not secret) | Public host |
| `SIPGES_MIGRATION_DATABASE_URL` | GitHub environment `production` | Direct Neon URL for `migrate.mjs` |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub environment `production` | `wrangler` in the deploy workflow |
| Neon role password | Neon console (through Vercel), and inside the Hyperdrive config | Database login for the Worker |
| MCP / ingest API keys | `api_keys` table, SHA-256 of the secret part only | External clients; shown once at creation |

Which Worker secrets are currently set cannot be checked from the repository; list them with
`pnpm exec wrangler secret list` in `apps/hosting-cloudflare`.

### How to rotate

| Secret | Steps | Side effect |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Create a new token (Workers and Hyperdrive edit), update the GitHub `production` secret, revoke the old token | None |
| `SIPGES_MIGRATION_DATABASE_URL` / Neon role password | Reset the role password in Neon, update the GitHub secret and the Hyperdrive connection, then run a deploy | The Worker fails to connect until Hyperdrive has the new password |
| `SIPGES_GOOGLE_CLIENT_SECRET` | Add a new secret on the OAuth client in Google Cloud, `wrangler secret put SIPGES_GOOGLE_CLIENT_SECRET`, delete the old one | None for existing sessions |
| `SIPGES_ADMIN_PASSWORD` | Change the password inside SIPGES; delete the secret with `wrangler secret delete SIPGES_ADMIN_PASSWORD` (only read on an empty database) | None |
| VAPID keys | `pnpm --filter @sipges/api vapid:keys`, then `wrangler secret put` each key | Every device subscription stops working and must subscribe again |
| API key (MCP, webhook) | Revoke it in Integraciones and create a new one | Clients using the old key get 401 |
| `SIPGES_DATA_KEY` | **No rotation tool exists.** The cipher format is versioned (`v1.`) to allow it later, but nothing re-encrypts stored secrets today, although ADR 0004 says rotation is a documented procedure | Changing it breaks every enrolled MFA factor and every pseudonym (ADR 0030). Do not change it |

Keep a copy of `SIPGES_DATA_KEY` in a password manager, separate from any database backup.

## Incident checklist

### Bad deploy

1. Confirm: `curl -fsS https://sipges.dreamcoder-dev08.workers.dev/health` and the last
   `Deploy Workers` run in GitHub Actions.
2. Roll back the code: `pnpm exec wrangler rollback` in `apps/hosting-cloudflare` (previous Worker
   version). See [rolling back](../deployment/cloudflare-workers.md#rolling-back).
3. Migrations are forward-only and must stay compatible with the previous version. If the bad
   change was a migration, restore the database ([below](#backup-and-restore)) instead.
4. Revert the commit on `main` with a PR, so the next green CI run does not redeploy it.
5. Today the deploy workflow only smoke-tests `/health`, which does not query the database, and
   does not roll back on its own (`odd/tasks/functional-closure.md` T1 is open for both).

### Leaked key or secret

1. Rotate it with the table above, starting with whatever grants the widest access (Cloudflare
   token, database URL).
2. A leaked SIPGES session or password: deactivate the account (this deletes all its sessions),
   reset the password, reactivate. An administrator can also reset its MFA
   (`POST /system/auth/accounts/:username/reset-mfa`).
3. Read Auditoría for the period of exposure; egress to external AI is logged under module
   «IA externa», action `EGRESS`.
4. If the secret was ever committed, rotating it is mandatory; removing it from git history does
   not undo the leak.

### Lost `SIPGES_DATA_KEY`

1. Restore it from the password manager and `wrangler secret put SIPGES_DATA_KEY`. Nothing else
   brings stored TOTP secrets back.
2. If no copy exists, set a new key: every enrolled MFA factor fails (a sealed secret that cannot
   be opened fails the factor) and pseudonyms change. An administrator resets each person's MFA
   with the route above and they enrol again.
3. If the only administrator is locked out, recovery depends on Google sign-in or direct database
   access; whether Google sign-in still requires the TOTP factor was not verified for this guide.

## Backup and restore

**Status: not yet drilled.** No restore has been rehearsed against production, and none of the
steps below has been run end to end (`docs/deployment/readiness.md` §8; `functional-closure.md`
lists a Neon restore drill as outside the code).

### What exists

| Data | Backup mechanism | Verified? |
| --- | --- | --- |
| PostgreSQL (Neon) | Neon's point-in-time restore (history retention depends on the Neon plan) | Not verifiable here: plan and retention window are in the Neon console |
| Evidence files (R2 `sipges-evidence`) | None configured in the repository | Not verifiable here; treat as unprotected until a copy is set up |
| One project's records | `GET /system/export` downloads `sipges-tenant.json` (active project, no auth material) | Verified: `tenancy-routes.ts` |
| `SIPGES_DATA_KEY` | Owner's password manager | Not verifiable here |

### Restore runbook (to drill)

1. Pick the target time, just before the incident. Write it down in UTC.
2. In Neon, restore the production branch to that time into a **new** branch first; never
   overwrite the only copy.
3. Point a scratch Hyperdrive config or a local API (`SIPGES_DATABASE_URL`) at the restored branch
   with the same `SIPGES_DATA_KEY`. Sign in, check MFA, compare a `sipges-tenant.json` export with
   the last known good one.
4. Restore R2 objects to the same point, if a copy exists. Records whose files are missing will
   fail to download.
5. Switch production: make the restored branch the one Hyperdrive uses, then deploy so the
   migrations run (`migrate` before `deploy:worker`).
6. Record the drill (date, target time, duration, what failed) in an ODD log and change the
   status above.
