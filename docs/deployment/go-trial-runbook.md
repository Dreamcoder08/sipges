# Go trial runbook (`sipges-go`)

The steps for the Cloudflare trial of the Go container: B1 in [the go/no-go](go-activation-reads.md), step 3 of its order of work. **Nothing here has been run.** Every step needs the owner's go-ahead and the owner's accounts. It never touches production: `sipges-go` is a separate Worker, on a Neon branch.

The SQL was run on a synthetic PostgreSQL 18.6 with an owner shaped like Neon's (`NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS`). There, row-level security and the record history kept working after the reassignment, Go started as `sipges_app`, and Go refused the owner role. **Unverified on Neon itself.** Commands that mention Neon and Hyperdrive were read from their reference pages, not executed.

Before starting: `main` holds B5, B6 and the real `SCREENS`, and Docker with buildx is running. Work in a fresh clone with `pnpm install` and **no `data/` directory**; step 5 moves it to the `trial/go-routes` branch before the deploy. Wrangler feeds Docker the Dockerfile on standard input, so `Dockerfile.dockerignore` does not apply and the whole clone, `node_modules` included, goes to the local build context. The image still takes only what the Dockerfile copies.

## Stop here first: which data

A Neon branch of production is a copy of its rows. **That is real data, and using it needs the owner's word** (B7). Pick one before step 1:

| Data | Branch | Database setup |
| --- | --- | --- |
| Synthetic (default) | `--schema-only`, no rows copied | Step 2A: an empty database of its own |
| Copy of production, with the owner's word | Full branch | Step 2B: reassign ownership |

Why 2A does not reuse the schema-only `neondb`: it has every table and no row in the migrations table, so `migrate` would replay `0001` over existing tables and stop.

Measuring on synthetic data needs enough rows first: the [memory table](go-container.md#memory) used 5,000 records. With few rows the Registros figures mean little.

## 1. Neon branch

Never the production branch: every database URL below is on `go-trial`.

```bash
neon branches create --project-id "$NEON_PROJECT_ID" --name go-trial --parent <production branch> --schema-only
```

Leave out `--schema-only` for a copy. Connect as the owner, through the direct host (not `-pooler`):

```bash
psql "$(neon connection-string go-trial --project-id "$NEON_PROJECT_ID" --role-name neondb_owner --database-name neondb)"
```

Confirm where you are, and who owns the tables. If the owner is not `neondb_owner`, use that name in step 2.

```sql
SELECT current_user, current_database(), inet_server_addr();
SELECT DISTINCT pg_get_userbyid(relowner) FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'S');
```

## 2. The `sipges_app` role

Created by SQL on purpose. Neon adds roles made in its console, CLI or API to `neon_superuser`, which brings `BYPASSRLS`; Go refuses to start on such a role, and row-level security would not hold. Neon rejects hashed passwords, so use this form, not `\password`. Neon asks for 60 bits of entropy.

```sql
\set ON_ERROR_STOP on
\prompt 'Password for sipges_app: ' app_password
CREATE ROLE sipges_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  PASSWORD :'app_password';
-- The owner must be able to act as sipges_app to hand objects over to it.
GRANT sipges_app TO neondb_owner WITH SET TRUE;
```

### 2A. Synthetic: an empty database

`sipges_app` has no `CREATEROLE`, and migration `0003` still names `mascli_tenant`, so the role must exist first. If `CREATE ROLE` says it already exists, go on.

```sql
CREATE ROLE mascli_tenant NOLOGIN NOINHERIT;
GRANT sipges_tenant, mascli_tenant TO sipges_app WITH ADMIN OPTION;
CREATE DATABASE sipges_trial OWNER sipges_app;
```

Use `sipges_trial` as the database in every URL below. Step 4 fills it. Create a synthetic `consulta` load account for the measurement.

### 2B. Copy of production: reassign ownership

With the owner's word only. Run it in `neondb` on `go-trial`. This changes the owner of the tables, sequences, functions and the database on this branch alone. Without it, `sipges_app` could not run migrations or the tables' owner-only work, and the `SECURITY DEFINER` history function would keep running as a role with `BYPASSRLS`.

```sql
GRANT sipges_tenant TO sipges_app WITH ADMIN OPTION;
REASSIGN OWNED BY neondb_owner TO sipges_app;
```

Set `SIPGES_DATA_KEY` in step 6 to the key of that data, or stored secrets will not open.

### Check, in either case

For 2B run this now, in `neondb`. For 2A the ownership query means something only after step 4, in `sipges_trial`.

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
FROM pg_roles WHERE rolname = 'sipges_app';            -- all four false
SELECT count(*) FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'S')
  AND pg_get_userbyid(relowner) <> 'sipges_app';       -- 0, run in the trial database
```

Build the URLs by hand, with the password URL-encoded and the direct host of `go-trial`:

```text
TRIAL_URL=postgresql://sipges_app:<password>@<direct host>/<database>?sslmode=require
```

## 3. Cloudflare resources

Run from `apps/hosting-cloudflare`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set.

```bash
pnpm exec wrangler hyperdrive create sipges-go-trial --connection-string="$TRIAL_URL" --update-config=false
pnpm exec wrangler hyperdrive update <id> --caching-disabled true
pnpm exec wrangler r2 bucket create sipges-evidence-go --update-config=false
```

**Keep `--update-config=false`.** These commands read `wrangler.jsonc`, the production config, and otherwise offer to write the new resource into it, with yes as the default. Confirm `git status` is clean afterwards.

Query caching stays off for the reason in `deploy-config.test.ts`: a cached read could keep a revoked session alive. `pnpm config:go` only compares ids, so it cannot see where a new Hyperdrive points: check that `TRIAL_URL` names the `go-trial` host before running this step.

## 4. Build and migrate

```bash
pnpm --filter @sipges/hosting-cloudflare build
SIPGES_MIGRATION_DATABASE_URL="$TRIAL_URL" pnpm --filter @sipges/hosting-cloudflare migrate
```

## 5. The route list and the config

Nothing starts the container while `GO_ROUTES` is empty, and `main` keeps it empty. Create an unmerged branch `trial/go-routes`, paste **Wave A** into `GO_ROUTES` in `src/go-routes.ts`, and deploy from there. **Never merge it**: `go-activation-reads.test.ts` and `go-smoke.test.ts` hold `main` to an empty list.

`wrangler.go.jsonc` declares no Hyperdrive on purpose. This writes `wrangler.go.deploy.jsonc`, which git ignores, and refuses the production id, the old all-zero placeholder and anything that is not an id:

```bash
SIPGES_GO_HYPERDRIVE_ID=<id> pnpm config:go
```

Already set in the config and in code: `instance_type: "basic"`, `regions: ["ENAM"]`, `sleepAfter: 10m`. The image embeds `pdf-text.wasm` and `pdfjs.qbc`; CI's `Go image` job builds it whenever Go changes.

## 6. Secrets

Each command prompts for its value, so nothing lands in the shell history.

```bash
for name in SIPGES_GO_DATABASE_URL SIPGES_DATA_KEY SIPGES_ADMIN_USERNAME SIPGES_ADMIN_PASSWORD SIPGES_ADMIN_FULL_NAME; do
  pnpm exec wrangler secret put "$name" -c wrangler.go.deploy.jsonc
done
```

`SIPGES_GO_DATABASE_URL` is the `sipges_app` URL with `sslmode=verify-full&pool_max_conns=10`, on the direct host. Ten matches the TypeScript pool; it was not measured. Hyperdrive and this URL must use the same role. For synthetic data, `SIPGES_DATA_KEY` is a new `openssl rand -base64 32`, never production's. `SIPGES_ADMIN_PASSWORD` needs at least 12 characters. To exercise `/system/automations/runtime`, also set `SIPGES_CRON_SECRET` (24 characters or more; a shorter one stops the container) and add `SIPGES_CRON_SCHEDULE` as a var: unset, Go reports `null` where TypeScript reports `*/15 * * * *`.

## 7. Deploy

```bash
pnpm exec wrangler deploy -c wrangler.go.deploy.jsonc
```

Wrangler builds and pushes the image. The first rollout can take minutes: until then the proxy answers its JSON 503.

## 8. Check it

Run these against `https://sipges-go.dreamcoder-dev08.workers.dev`, then work through the trial checklist in the [go/no-go](go-activation-reads.md#what-must-be-true-first).

| Check | Expected |
| --- | --- |
| `GET /health/ready` | `200`, from TypeScript through Hyperdrive |
| `GET /api/dashboard`, no session | `401 {"detail": "Inicie sesión para acceder a SIPGES"}`, the first call starts the container. TypeScript's body is the same: confirm in the container's log that Go answered |
| `SIPGES_SMOKE_URL=<origin> node smoke-go.mjs` | `Listed route answered the sign-in 401` |
| Same route after setting `SIPGES_GO_DATABASE_URL` to the owner's URL, which Go refuses at start. The container reads its environment when it starts, so wait for `sleepAfter` or redeploy | `503 {"detail": "SIPGES no está disponible temporalmente"}`, never text. Restore the secret the same way |
| Container logs at start | No `must not be a superuser or have BYPASSRLS` |

Then [measure](go-activation-reads.md#measurement-with-the-owner).

## 9. Roll back or remove

Time each rollback: the go/no-go still marks them unverified. Remove in this order, with the owner:

```bash
pnpm exec wrangler delete --config wrangler.go.deploy.jsonc
pnpm exec wrangler hyperdrive delete <id>
pnpm exec wrangler r2 bucket delete sipges-evidence-go
neon branches delete go-trial --project-id "$NEON_PROJECT_ID"
```

Then confirm `wrangler containers list` no longer shows `sipges-go-gobackend`, and delete it with `wrangler containers delete <id>` if it does.

Deleting the branch deletes the copy, its `sipges_app` and its password. They were created on `go-trial`, so production never had them.

## Not enabled: OCR

`SIPGES_OCR` stays unset, and `ocrmypdf` and Tesseract are not in the image ([ADR 0033](../adr/0033-pdf-text-in-wasm.md)). So a scanned PDF answers as it does without OCR. If it is ever enabled, **add a concurrency cap first**: Go caps PDF text reads (`pdfSlots`) but has no cap on OCR processes, and one page took 24 s and 282 MiB at 1/4 vCPU, so a few at once would exhaust a `basic` instance.

## Evidence files from the container

The R2 binding (`EVIDENCE`) exists only in the Worker. The container reaches the same bucket through R2's S3 API, with the client Go already has (`objectstore.S3`): same keys, so TypeScript and Go read each other's files. **Not proved against real R2:** no credentials exist yet, so the first upload on the trial is the proof.

| Name | Value |
| --- | --- |
| `SIPGES_STORAGE` | `s3` |
| `SIPGES_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `SIPGES_S3_REGION` | Leave unset: `auto` |
| `SIPGES_S3_BUCKET` | The Worker's own bucket: `sipges-evidence-go` on the trial, `sipges-evidence` in production |
| `SIPGES_S3_ACCESS_KEY_ID`, `SIPGES_S3_SECRET_ACCESS_KEY` | An R2 token with Object Read & Write on that one bucket, one token per Worker |

**Set `SIPGES_STORAGE` last.** The Worker passes every string it has to the TypeScript config, even though TypeScript stores through the binding. `SIPGES_STORAGE=s3` with the endpoint, bucket or either key missing makes that config throw, and then the whole Worker fails, the web shell included. Once the set is complete, TypeScript validates it and keeps using the binding.

Unset, Go uses local storage on the container's disk, and nothing there survives a restart. So `s3` must be in place before any upload route moves.

Considered: `@cloudflare/containers` can send the container's outbound traffic through a Worker handler, which could use the binding with no long-lived credentials in the container. It would need new, untested Worker code in the path of every file, and the S3 client already has parity. If the token ever becomes a concern, this is the path to look at.

## Go-live list: names, never values

For step 6 of the order of work. "Passed" means `goContainerEnv` forwards it today; anything marked no needs a code change before the routes that use it move. The container reads its environment when it starts, so a changed value needs a restart. Every forwarded value is optional, and no secret may reach a log. The one setting Go logs is the public `SIPGES_ANALYST_MODEL`, in `briefing_narration_failed`, as TypeScript does.

| Name | Kind | Passed | Needed for |
| --- | --- | --- | --- |
| `SIPGES_GO_ROUTING` | var | Worker only | The switch: only in the change that adds the first routes |
| `SIPGES_ALLOWED_HOSTS` | var | yes | Every route |
| `SIPGES_GO_DATABASE_URL` | secret | yes, as `SIPGES_DATABASE_URL` | Every route |
| `SIPGES_ADMIN_USERNAME`, `SIPGES_ADMIN_PASSWORD`, `SIPGES_ADMIN_FULL_NAME` | secret | yes | Bootstrap of an empty installation |
| `SIPGES_CRON_SECRET` or `CRON_SECRET` | secret | yes | `/system/automations/runtime` |
| `SIPGES_CRON_SCHEDULE` | var | yes | `/system/automations/runtime` |
| `SIPGES_HOST`, `SIPGES_PORT`, `SIPGES_TRUST_CF_CONNECTING_IP` | fixed in code | yes | Every route |
| `GOMEMLIMIT` | fixed in the image | n/a | Memory limit |
| `SIPGES_REQUIRE_MFA`, `SIPGES_COOKIE_SECURE` | var | yes, when set | Unset stays unset and means on in Go. The Worker adds no default. Confirm production does not override them |
| `SIPGES_DATA_KEY`, `SIPGES_DATA_KEY_PREVIOUS` | secret | yes, when set | TOTP, identity and automation channel writes. With the key, a write route on Go sends through real channels: see [go-automation-cron.md](go-automation-cron.md) |
| `SIPGES_GO_AUTOMATION_CRON`, `SIPGES_AUTOMATION_INTERVAL` | var | no, on purpose | The Go cron: see [go-automation-cron.md](go-automation-cron.md) |
| `SIPGES_STORAGE`, `SIPGES_S3_ENDPOINT`, `SIPGES_S3_REGION`, `SIPGES_S3_BUCKET`, `SIPGES_MAX_UPLOAD_BYTES` | var | yes, when set | Uploads, previews and downloads. See [Evidence files from the container](#evidence-files-from-the-container) |
| `SIPGES_S3_ACCESS_KEY_ID`, `SIPGES_S3_SECRET_ACCESS_KEY` | secret | yes, when set | Uploads, previews and downloads |
| `SIPGES_GOOGLE_CLIENT_ID`, `SIPGES_GOOGLE_ADMIN_EMAIL` | var | yes, when set | Google sign-in, `/system/auth/providers` |
| `SIPGES_GOOGLE_CLIENT_SECRET` | secret | yes, when set | Google sign-in |
| `SIPGES_VAPID_PUBLIC_KEY`, `SIPGES_VAPID_SUBJECT` | var | yes, when set | Push |
| `SIPGES_VAPID_PRIVATE_KEY` | secret | yes, when set | Push |
| `SIPGES_OLLAMA_URL`, `SIPGES_OLLAMA_EMBED_MODEL`, `SIPGES_SEMANTIC_SEARCH` | var | yes, when set | Semantic analysis |
| `SIPGES_ANALYST_PROVIDER`, `SIPGES_ANALYST_MODEL`, `ANTHROPIC_BASE_URL` | var | yes, when set | Analyst prose |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | secret | yes, when set | Analyst prose |
| `SIPGES_OCR`, `SIPGES_OCR_LANGUAGES` | var | no, not enabled | OCR, see above |
| `SIPGES_ACCESS_LOG` | var | yes, when set | Go's request log. TypeScript reads it too |
| `SIPGES_TRUST_PROXY`, `SIPGES_UPLOAD_DIR` | var | no, not for Cloudflare | Other hosting: the Worker sets `SIPGES_TRUST_CF_CONNECTING_IP`, and uploads go to S3 |
| `SIPGES_ALLOW_PRIVILEGED_DB_ROLE` | var | no, never set | Synthetic test servers on loopback only |

Outside the Worker:

| Name | Where | For |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Shell, GitHub `production` | Deploys |
| `SIPGES_MIGRATION_DATABASE_URL` | Shell, GitHub `production` | `migrate` |
| `SIPGES_GO_HYPERDRIVE_ID` | Shell | `pnpm config:go`, trial only |
| `SIPGES_SMOKE_URL` | Shell, `deploy-workers.yml` | `smoke-go.mjs` |
| `SIPGES_LOAD_BASE_URL`, `SIPGES_LOAD_USER`, `SIPGES_LOAD_PASSWORD`, `SIPGES_LOAD_TOTP`, `SIPGES_LOAD_SCOPE` | `~/.config/sipges-carga.env` | The benchmark |

Production also needs B4: its own container, Durable Object migration and buildx in `deploy-workers.yml`.

## Sources

- [Neon: manage roles](https://neon.com/docs/manage/roles), [database access](https://neon.com/docs/manage/database-access), [schema-only branches](https://neon.com/docs/guides/branching-schema-only)
- [Neon CLI: branches](https://neon.com/docs/reference/cli-branches), [connection-string](https://neon.com/docs/reference/cli-connection-string)
- [Wrangler: Hyperdrive commands](https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/)
