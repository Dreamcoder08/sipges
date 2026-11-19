# Moving production from Neon to PlanetScale Postgres

Production answers `503` because the Neon project went over its free quota. Every deploy stops at `migrate`, and the quota resets on 2026-12-01. The owner decided to move to PlanetScale Postgres behind the existing Cloudflare Hyperdrive. This guide covers the owner's steps, the cutover order and its rollback, and what is still unproven.

**Nothing here has run against Neon, PlanetScale or Cloudflare.** The tool and the order were rehearsed locally on synthetic data only, between two PostgreSQL 18.7 clusters and through a local PgBouncer ([Rehearsal](#what-was-proven-locally)).

## The blocker: Neon must answer before anything moves

The export reads the Neon database. Neon has paused the compute because the project went over its quota, so `pg_dump` cannot connect. There are two ways through:

| Way | Cost | When |
| --- | --- | --- |
| Wait for the quota reset | Free | On 2026-12-01; production stays down until then |
| Upgrade the Neon project to a paid plan for the export, then downgrade | One billing period of the paid plan | As soon as the owner chooses |

The move cannot start until one of these happens. Everything else in this guide can be prepared before then.

## Quick path

1. Create the PlanetScale database and the empty `sipges` database inside it ([Step 1](#step-1-the-planetscale-database)).
2. Freeze deploys, then run `deploy/cloud/move-postgres.sh move` from Neon to PlanetScale ([Steps 2 and 3](#step-2-freeze)).
3. Point Hyperdrive and the migration secret at PlanetScale, as `sipges_app` ([Steps 4 and 5](#step-4-hyperdrive)).
4. Lift the freeze, deploy, and smoke-test ([Step 6](#step-6-deploy-and-smoke-test)).

Expected time once Neon answers: about 30 minutes, most of it checking.

## What the move tool does

`deploy/cloud/move-postgres.sh preflight|move|verify <work dir>`:

| Phase | What happens |
| --- | --- |
| Preflight | Checks the `pg_dump` version against both servers. The source login must bypass RLS, or the dump would miss rows. The target admin must bypass RLS and be able to create roles. The target schema must be empty. Writes nothing. |
| Dump | One `REPEATABLE READ` read-only transaction on the source exports a snapshot. The tool hashes every table's rows and records the schema shape inside it, and `pg_dump --snapshot` reads the same snapshot. So the proof and the dump describe the same data, even if something writes meanwhile. |
| Restore | Creates `sipges_tenant` and `sipges_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`). It adds a temporary stand-in for each Neon role the dump names, such as `neon_superuser`. Then `pg_restore --single-transaction` loads everything or nothing. The stand-ins and their grants are dropped, and every table, sequence and function is handed to `sipges_app`. Neon's default privileges are skipped, because no migration sets any. |
| Verify | Checks that every table's row count and hash match, and that every sequence matches. Checks that columns, constraints, indexes, policies, triggers, functions, and grants to `PUBLIC`, `sipges_tenant` and the owner match. Then proves RLS as `sipges_app`: with no tenant, forced tables show 0 rows. For every tenant and table, the tenant sees exactly its own rows and 0 of anyone else's. |

The source is only read. Every source session runs with `default_transaction_read_only=on`, and the rehearsal checked that the source dump is byte-identical before and after. Any failed check ends with `verification FAILED: do not switch to the target`.

## Step 1: the PlanetScale database

In the PlanetScale dashboard:

1. Create a **Postgres** database, version 18. Choose **AWS us-east-1 (N. Virginia)**, or the nearest us-east region offered. Neon was in aws-us-east-1, and the Worker and the Go container are placed in Cloudflare's ENAM.
2. Create a password for the default role `postgres`. It connects as `postgres.<branch id>`, and PlanetScale defines it as `NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS` ([roles](https://planetscale.com/docs/postgres/connecting/roles)), which is what the tool needs.
3. Make the private directory of Step 2 (`umask 077; mkdir -p "$DIR"`), save the `postgres` role URL to its `postgres` database there, on port **5432** (not PgBouncer's 6432), and create the database. The default role then owns it, which lets it grant `CREATE` on `public`:

```bash
psql "$(cat "$DIR/ps-admin-postgres.url")" -X -c 'CREATE DATABASE sipges'
```

Do not create `sipges_app` in the dashboard. The tool creates it by SQL with the password you give it. Roles created by SQL do not show in the dashboard, and they connect as `sipges_app.<branch id>`.

## Step 2: freeze

As in [production-role-cutover.md](production-role-cutover.md#step-0-freeze-save-restore-point):

```bash
gh workflow disable deploy-workers.yml
gh run list --workflow deploy-workers.yml --limit 20 --json status \
  --jq '[.[] | select(.status != "completed")] | length'   # must print 0
umask 077; mkdir -p "$DIR"
openssl rand -hex 32 > "$DIR/app.pw"
```

`$DIR` is a private directory outside the repository. Keep these files, and never print them:

| File | Holds |
| --- | --- |
| `source.url` | Neon's **direct** host (not `-pooler`), as `mascli_workers` or `neondb_owner`. Both bypass RLS through `neon_superuser`. Keep `sslmode=require`. |
| `target.url` | `postgres://postgres.<branch id>:…@<host>:5432/sipges?sslmode=verify-full&sslrootcert=system` |
| `app.url` | The same host and database, as `sipges_app.<branch id>` with the password in `app.pw` |

The commands below pass URLs as arguments, so a URL is visible in the process list while a command runs. Use a machine only you have access to.

## Step 3: move

From a fresh clone of `main`, with `psql`, `pg_dump` and `pg_restore` 18:

```bash
export SIPGES_MOVE_SOURCE_URL="$(cat "$DIR/source.url")"
export SIPGES_MOVE_TARGET_URL="$(cat "$DIR/target.url")"
export SIPGES_MOVE_APP_URL="$(cat "$DIR/app.url")"
export SIPGES_MOVE_APP_PASSWORD="$(cat "$DIR/app.pw")"
export PGPASSWORD="$(cat "$DIR/app.pw")"   # only if app.url carries no password
deploy/cloud/move-postgres.sh preflight "$DIR/move"
deploy/cloud/move-postgres.sh move "$DIR/move"
```

Go on only if the last line is `verify: ok`. The work directory then holds the dump, the hashes and the diffs. Keep it until the observation window ends.

If the move fails partway, the restore has rolled back. Drop and recreate the `sipges` database on PlanetScale, then run `move` again into a new work directory.

## Step 4: Hyperdrive

Point the production Hyperdrive at PlanetScale on port **5432**, as `sipges_app`. Hyperdrive pools connections itself, so it does not go through PgBouncer. Updating in place keeps the same id, so `SIPGES_HYPERDRIVE_ID` and the Worker do not change. Run from `apps/hosting-cloudflare`:

```bash
pnpm exec wrangler hyperdrive update <production Hyperdrive id> \
  --connection-string="$(cat "$DIR/app.url")" > "$DIR/hyperdrive.log" 2>&1
grep -E '"user"|"disabled"' "$DIR/hyperdrive.log"
```

Expect `sipges_app.<branch id>` and `"disabled": true`, which means query caching stays off. If it reads `false`, run `wrangler hyperdrive update <id> --caching-disabled true`. Hyperdrive tests the connection first and keeps the old config if the test fails.

## Step 5: secrets

Names only. Values come from `$DIR`.

| Name | Where | Value |
| --- | --- | --- |
| `SIPGES_MIGRATION_DATABASE_URL` | GitHub, environment `production` | `app.url`, direct port 5432 |
| `SIPGES_HYPERDRIVE_ID` | GitHub variable | Unchanged after an in-place update |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub secrets | Unchanged |
| `SIPGES_GO_DATABASE_URL` | Worker secret of the Go trial Worker, only when Go serves | `app.url`, on port 5432, or 6432 for PlanetScale's PgBouncer |

```bash
gh secret set SIPGES_MIGRATION_DATABASE_URL --env production < "$DIR/app.url"
SIPGES_MIGRATION_DATABASE_URL="$(cat "$DIR/app.url")" pnpm --filter @sipges/hosting-cloudflare migrate
```

Expect `Database up to date (33 migrations known)`.

## Step 6: deploy and smoke-test

```bash
gh workflow enable deploy-workers.yml
gh workflow run deploy-workers.yml --ref main
```

| Check | Expected |
| --- | --- |
| The workflow's migrate step | `Database up to date` |
| `GET /health/ready` | `200` |
| Sign in, then Inicio, Registros, Bandeja | Same records as before the outage |
| `automation_cursors` after the next `:15` | Fresh `cron`, `completed` line for each project |

## Rollback

| Reached | Do this |
| --- | --- |
| Before Step 4 | Nothing in production changed. Lift the freeze; production stays on Neon. |
| After Step 4 | Point Hyperdrive back to Neon with Step 4 and the Neon URL, then set `SIPGES_MIGRATION_DATABASE_URL` back. **This only works while Neon answers**, because Hyperdrive refuses a connection it cannot test. Anything written on PlanetScale after the switch stays there: moving it back means running this tool in reverse into an empty Neon database. |

Keep the Neon project, read-only and untouched, until the owner ends the observation window.

## The pooling fix this move needed

Hyperdrive and PlanetScale's PgBouncer both pool in **transaction mode**. Each transaction may run on a different server connection, and a few server connections serve every client. The local proof found one real defect and confirmed the rest:

| Concern | Finding |
| --- | --- |
| Tenant settings (`app.tenant_id`, `app.actor`, `app.clearance`, role) | Both APIs set them with `set_config(…, true)` inside the transaction, which is `SET LOCAL`. Nothing outlives the transaction. |
| Advisory locks | Only `pg_advisory_xact_lock`. Session locks exist only in test helpers. |
| TypeScript API | `prepare: false` in Node. The Worker uses `prepare: true` through Hyperdrive, which supports postgres.js named statements. This is unchanged by the move. |
| **Go API** | pgx's default named statements (`stmtcache_…`) broke behind a transaction pooler: 566 of 600 tenant jobs failed with `prepared statement … already exists`. `database.Open` now defaults to `cache_describe`, which keeps the unnamed statement, one round trip and binary formats. `default_query_exec_mode` in the URL still overrides it. |

## What was proven locally

| Proof | Command | Result |
| --- | --- | --- |
| Concurrent tenants through PgBouncer in transaction mode (3 server connections, `max_prepared_statements=0`, no reset query) | `SIPGES_TEST_POOLER_ADDR=$(scripts/agents/test-pgbouncer.sh addr) go test -race ./internal/platform/database/` | 600 jobs across 3 tenants. 0 cross-tenant rows, and no setting or role survived a transaction. |
| Both APIs through the same pooler, as a NOBYPASSRLS owner with forced RLS | `SIPGES_PARITY_POOLER_ADDR=… pnpm parity` | 2752 of 2752 cases match, including the cross-project cases |
| Both APIs directly | `pnpm parity` | 2752 of 2752 |
| The move, with a Neon-shaped source and a PlanetScale-shaped target admin | `deploy/cloud/test/rehearse-move.sh` | 35 tables and 13 sequences identical, and 2127 shape lines identical. RLS held across 7 tenants and 26 tables, with 1849 tenant rows. The source dump was byte-identical before and after. `migrate` as `sipges_app` was up to date. A wrong password was refused. Three planted faults each failed `verify`: a changed row, a lifted `FORCE`, and `sipges_app` with `BYPASSRLS`. |

To run the local proofs, start PostgreSQL with `scripts/agents/test-pg.sh up`, then PgBouncer with `scripts/agents/test-pgbouncer.sh up`. The PgBouncer script needs a `pgbouncer` binary: the distribution package, or `PGBOUNCER=<path>`. On OpenSSL 4, a source build needs `--without-openssl`, which is fine for loopback.

## Unproven until a real PlanetScale branch exists

1. **That PlanetScale's `postgres` role behaves like the rehearsal's stand-in.** The tool depends on creating roles, `GRANT sipges_app TO CURRENT_USER`, `DROP OWNED BY` a role it created, and `ALTER … OWNER`. A refusal stops the move in the restore transaction, before anything is switched.
2. **The `<role>.<branch id>` usernames** through Hyperdrive, pgx and postgres.js, and `sslmode=verify-full sslrootcert=system` in pgx and postgres.js.
3. **Hyperdrive itself.** Hyperdrive was not run: PgBouncer stood in for it. Its handling of postgres.js named statements is Cloudflare's, as on Neon today.
4. **The real Neon export.** The `neon_superuser` grants were emulated. The real dump may name other platform roles: the tool creates a stand-in for each, and the shape check ignores only grants to roles other than `PUBLIC`, `sipges_tenant` and the owner.
5. **Size and time.** The rehearsal moved about 2,000 synthetic rows in seconds. Production was 23 MB on 2026-11-06.
6. **Latency** from Hyperdrive and the ENAM container to the chosen PlanetScale region.
7. **The schema needs no extension.** No migration runs `CREATE EXTENSION`, so PostGIS, pgvector and the rest play no part. A later migration that adds one needs PlanetScale's extension settings, and many of those extensions require a superuser.

## Sources

- PlanetScale: [connecting](https://planetscale.com/docs/postgres/connecting), [roles](https://planetscale.com/docs/postgres/connecting/roles), [PgBouncer](https://planetscale.com/docs/postgres/connecting/pgbouncer), [imports](https://planetscale.com/docs/postgres/imports), [extensions](https://planetscale.com/docs/postgres/extensions)
- Cloudflare: [Hyperdrive and PlanetScale](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/planetscale-postgres/), [supported features](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
- pgx: `QueryExecMode` in `github.com/jackc/pgx/v5` `conn.go`
