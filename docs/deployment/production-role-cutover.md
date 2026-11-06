# Production role cutover: `mascli_workers` to `sipges_app`

Moves production from a login with `BYPASSRLS` to one without it, so row-level security holds for the login itself and Go can start. **Nothing here has been run on production.** Each step runs with the owner, in order, in one sitting of about five minutes.

The order was rehearsed on 2026-11-06 on a full copy of production, with the real TypeScript Worker serving through its own Hyperdrive: about 5,100 requests at 3.3 per second across all passes, plus 82 page visits in a real browser. Steps 1 to 7 in this order failed no request. The results are [below](#rehearsal-results).

## The order

| # | Step | Failed requests in the rehearsal | Time |
| --- | --- | --- | --- |
| 0 | Freeze deploys, save the old URL, create the password, take the restore point | None | 2 min |
| 1 | Create `sipges_app`; the old role inherits it | 0 | 1 s |
| 2 | Move the database owner through the Neon API | 0 | 1 s |
| 3 | Hand over tables one at a time, then functions | 0 | 8 s |
| 4 | Switch Hyperdrive to `sipges_app`, wait for old sessions to go | 0 | 3 s, then about 20 s |
| 5 | Replace the migration secret, run `migrate` | 0 | 2 s |
| 6 | Prove RLS | 0 | 3 s |
| 7 | Revoke what the old role inherited | 0 | 2 s |
| 8 | Lift the freeze, watch one cron tick | Not measured | 15 min |
| 9 | After the observation window: retire the old password, delete the restore point | Not rehearsed under traffic | 1 min |

The running Worker never loses access, for two reasons. In step 1 the old role inherits `sipges_app`, so it keeps every owner right while ownership moves. Hyperdrive switches only after `sipges_app` owns everything it needs.

### Why not grant first, switch Hyperdrive, then reassign

That order was considered and not run, because the evidence removed its reason and found a fault in it:

- **The premise does not hold on Neon.** `REASSIGN OWNED` does not strip the old role of table access. `neon_superuser` holds `pg_read_all_data` and `pg_write_all_data`, so `mascli_workers` kept reading and writing, and the Worker served through it with 0 failed requests and no inheritance. It loses only `CREATE` on the schema, which breaks `migrate`.
- **A non-owner breaks the cron silently.** The scheduler reads `SELECT tenant_id FROM automation_cursors` outside any tenant transaction. That table has RLS without `FORCE`, so its owner sees every tenant and a non-owner with no tenant set saw 0 rows. On a grants-only `sipges_app`, automation would stop with no error.

## Before you start

- The owner's word for this sitting, and a quiet hour, just after a `:15` cron tick.
- `psql` 15 or later, the Neon CLI, `gh`, and `wrangler` from `apps/hosting-cloudflare`.
- `NEON_PROJECT_ID`, a `NEON_API_KEY`, and `DIR`, a private directory outside the repository.

**Do not read these files aloud or `cat` them.** Everything below passes them by redirection.

## Step 0: freeze, save, restore point

A deploy can land mid-cutover: during the rehearsal, `Deploy Workers` for #335 ran and re-asserted caching on the production Hyperdrive. A `migrate` run by the old role during step 3 could also create objects that the old role owns.

```bash
gh workflow disable deploy-workers.yml
umask 077
mkdir -p "$DIR"

# Hyperdrive never gives a password back: this file is what makes step 4 reversible.
neon connection-string main --project-id "$NEON_PROJECT_ID" \
  --role-name mascli_workers --database-name mascli_workers > "$DIR/old.url"

# Hex: URL-safe, needs no encoding, and 256 bits against Neon's minimum of 60.
openssl rand -hex 32 > "$DIR/app.pw"
sed -e "s#//mascli_workers:[^@]*@#//sipges_app:$(cat "$DIR/app.pw")@#" \
  -e 's/&channel_binding=require//' "$DIR/old.url" > "$DIR/new.url"

# The restore point. No expiry: a branch with one cannot have children.
date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/before.txt"
neon branches create --project-id "$NEON_PROJECT_ID" --name pre-role-cutover --parent main
```

Confirm you are on production, as the old role:

```bash
psql "$(cat "$DIR/old.url")" -X -At -c "SELECT current_user, current_database()"
```

The password never reaches the screen, the shell history or the SQL text. `psql` reads it from the environment with `\getenv`. Neon refuses SCRAM verifiers, so the plain value does reach the server, encrypted in transit. Do not use the Neon console's SQL editor: it keeps the statement in its history, which happened on the trial branch. `wrangler hyperdrive update` takes the URL as an argument, visible in the process list for about 3 s, so run it on a machine only you use. A search of wrangler's logs found neither rehearsal password.

**Rollback:** `gh workflow enable deploy-workers.yml`. Delete the branch only if you stop here.

## Step 1: the role

```bash
SIPGES_APP_PASSWORD="$(cat "$DIR/app.pw")" psql "$(cat "$DIR/old.url")" -X -q -v ON_ERROR_STOP=1 <<'SQL'
\getenv app_password SIPGES_APP_PASSWORD
CREATE ROLE sipges_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  PASSWORD :'app_password';
GRANT sipges_app TO mascli_workers WITH INHERIT TRUE, SET TRUE;
GRANT sipges_tenant TO sipges_app WITH ADMIN OPTION;
SQL
```

Create it by SQL, never in the console, CLI or API: those add it to `neon_superuser`. Neon lists the role afterwards, and a restart did not raise it.

**Breaks:** nothing. **Rollback:** [R1](#rollback).

## Step 2: the database owner

`ALTER DATABASE` and `REASSIGN OWNED` do not last. A compute restart put `mascli_workers` back as owner, because Neon reapplies its own record. The API changes that record, and it survived a restart. It also gives `sipges_app` `CREATE` on `public`, which step 3 needs.

```bash
curl -fsS -X PATCH \
  "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/<production branch id>/databases/mascli_workers" \
  -H "Authorization: Bearer $NEON_API_KEY" -H 'Content-Type: application/json' \
  -d '{"database":{"owner_name":"sipges_app"}}' > /dev/null
```

A `423` means another operation is running: repeat it. Wait until the check answers `sipges_app`:

```bash
psql "$(cat "$DIR/old.url")" -X -At -c \
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()"
```

**Breaks:** nothing. **Rollback:** [R2](#rollback).

## Step 3: hand over, one object per transaction

**Do not use `REASSIGN OWNED` here.** It takes 34 exclusive locks in one transaction, and any request touching two tables closes the cycle: it deadlocked in 10 of 10 attempts at 3.3 requests per second. It failed safely, rolling back with no request lost, but it never finished. One `ALTER` per statement holds one exclusive lock at a time, and no handover deadlocked, forward or back. Sequences follow their tables.

Save as `handover.sql`:

```sql
SET lock_timeout = '3s';
SELECT format('ALTER TABLE %s OWNER TO sipges_app', c.oid::regclass)
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
  AND pg_get_userbyid(c.relowner) = 'mascli_workers'
ORDER BY c.relname \gexec
SELECT 'left', c.relkind, count(*) FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'S')
  AND pg_get_userbyid(c.relowner) = 'mascli_workers' GROUP BY 2;
```

```bash
psql "$(cat "$DIR/old.url")" -X -At -f handover.sql
```

A `canceling statement due to lock timeout` is harmless: run it again until no `left` line prints. **Only then** move the functions, last. The history trigger is `SECURITY DEFINER`, so it must always run as a role that can write `record_versions`.

```bash
psql "$(cat "$DIR/old.url")" -X -At <<'SQL'
SELECT format('ALTER FUNCTION %s OWNER TO sipges_app', p.oid::regprocedure)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND pg_get_userbyid(p.proowner) = 'mascli_workers' \gexec
SELECT count(*) AS must_be_0 FROM pg_shdepend d JOIN pg_roles r ON r.oid = d.refobjid
WHERE r.rolname = 'mascli_workers' AND d.deptype = 'o';
SQL
```

**Breaks:** nothing failed, and latency did not move. A request can wait up to 3 s behind one table. **Rollback:** [R3](#rollback).

## Step 4: Hyperdrive

Run from `apps/hosting-cloudflare`. The id is production's, so read it twice.

```bash
pnpm exec wrangler hyperdrive update 9eae2c5e3d614feca42b525fc82e10e1 \
  --connection-string="$(cat "$DIR/new.url")" > "$DIR/hyperdrive.log" 2>&1
grep -E '"user"|"disabled"' "$DIR/hyperdrive.log"
```

Expect `sipges_app` and `"disabled": true`. Hyperdrive tests the connection first and refuses a bad one, leaving the old config in place. The switch is live for the same id with no deploy: the first `sipges_app` session appeared 1 s after the command ended, and old sessions were gone about 20 s later.

Check the drain **as the old role**. `sipges_app` cannot see other users' `backend_type`, so asking as it always answers 0, which fooled the rehearsal once.

```bash
psql "$(cat "$DIR/old.url")" -X -At -c "SELECT usename, count(*) FROM pg_stat_activity
WHERE datname = current_database() AND backend_type = 'client backend' GROUP BY 1"
```

Wait until the only `mascli_workers` line is this query. Idle sessions took about 20 s one way and over 2 minutes the other; they were harmless.

**Breaks:** nothing. **Rollback:** [R4](#rollback), the fastest one: 3 s and no SQL.

## Step 5: the migration secret

After step 7 the old URL fails, so this comes first. The deploy job would stop at `migrate`, before `wrangler deploy`: safe, but blocked.

```bash
gh secret set SIPGES_MIGRATION_DATABASE_URL --env production < "$DIR/new.url"
SIPGES_MIGRATION_DATABASE_URL="$(cat "$DIR/new.url")" pnpm --filter @sipges/hosting-cloudflare migrate
```

Expect `Database up to date`, after a harmless `already exists` notice. **Rollback:** the same `gh secret set` with `old.url`.

## Step 6: prove RLS is enforced

Save as `rls.sql`. It writes nothing: the one `INSERT` must be refused, and every transaction rolls back.

```sql
\pset footer off
SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user;
SELECT count(*) AS no_tenant_must_be_0 FROM module_records;
BEGIN;
SET LOCAL ROLE sipges_tenant;
SELECT count(*) AS role_no_tenant_must_be_0 FROM module_records;
SELECT set_config('app.tenant_id', 'SIPGES/PRJ-ALGARROBO', true) \g /dev/null
SELECT count(*) AS own_rows_above_0 FROM module_records;
SELECT count(*) AS cross_tenant_must_be_0 FROM module_records WHERE tenant_id = 'SIPGES/PRJ-SECHURA';
SELECT count(*) AS cross_audit_must_be_0 FROM audit WHERE tenant_id = 'SIPGES/PRJ-SECHURA';
SELECT count(*) AS cross_history_must_be_0 FROM record_versions WHERE tenant_id = 'SIPGES/PRJ-SECHURA';
SAVEPOINT s;
INSERT INTO module_records (tenant_id, module, id, payload)
VALUES ('SIPGES/PRJ-SECHURA', 'Fuentes', 'RLS-PROBE', '{}');  -- must be refused
ROLLBACK TO s;
ROLLBACK;
BEGIN;
SELECT set_config('app.tenant_id', 'SIPGES/PRJ-ALGARROBO', true) \g /dev/null
SELECT count(*) AS login_cross_must_be_0 FROM module_records WHERE tenant_id = 'SIPGES/PRJ-SECHURA';
ROLLBACK;
```

```bash
psql "$(cat "$DIR/new.url")" -X -f rls.sql
```

| Check | Expected |
| --- | --- |
| `rolsuper`, `rolbypassrls` | `f`, `f` |
| Every `must_be_0` | `0` |
| `own_rows_above_0` | Above 0 |
| The `INSERT` | `new row violates row-level security policy` |

The opposite run is the control. As `mascli_workers`, the same cross-tenant query without `SET LOCAL ROLE` returns rows. Any non-zero result here means stop and go to [R4](#rollback).

**Over HTTP:** an account granted one project got `403` naming the other project in the header, `403` in `project_id`, and `404` for the other project's record id. Production has no such account to spare, so the SQL above is the proof; repeat this only with one already in place.

Then sign in and open Inicio, Registros and Bandeja.

## Step 7: stop inheriting

```bash
psql "$(cat "$DIR/old.url")" -X -q -v ON_ERROR_STOP=1 -c "REVOKE sipges_app FROM mascli_workers;"
```

This removes ownership rights only. `mascli_workers` **keeps `BYPASSRLS` and can still read and write everything** through `neon_superuser`, and it keeps `ADMIN` on `sipges_app` from `cloud_admin`. Neither can be removed: `cloud_admin` manages that role. The real boundary is step 9.

**Breaks:** nothing. **Rollback:** [R7](#rollback).

## Step 8: lift the freeze

```bash
gh workflow enable deploy-workers.yml
```

At the next quarter hour, both projects must show a fresh `cron`, `completed` line:

```bash
psql "$(cat "$DIR/new.url")" -X -At -c \
  "SELECT tenant_id, last_tick_finished_at, last_tick_source, last_tick_status FROM automation_cursors"
```

Do not force a compute restart to test the owner. The rehearsal's restart cost a stall of 1 to 2 s and four `500`s in the browser, and the next idle suspend proves the same thing. After it, the check in step 2 must still say `sipges_app`.

## Step 9: retire the old login

Wait for the observation window the owner sets. Until then `old.url` is the rollback.

```bash
curl -fsS -X POST \
  "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches/<production branch id>/roles/mascli_workers/reset_password" \
  -H "Authorization: Bearer $NEON_API_KEY" > /dev/null
neon branches delete pre-role-cutover --project-id "$NEON_PROJECT_ID"
```

Discard the response and delete `$DIR`. Nobody then holds the old password, which is what actually ends the `BYPASSRLS` login.

> **Never delete `mascli_workers`, in the Neon console or the API.** It is the grantor of `sipges_app`'s membership in `sipges_tenant`, and deleting it removed that membership too. Every tenant route answered `500`, and `neondb_owner` could not restore it (`Only roles with the ADMIN option`). The only tested way out was a restore. The role stays, with an unknown password.

## Rollback

Run backwards from the step you reached.

| Step | Do this | Rehearsed | Failed requests |
| --- | --- | --- | --- |
| R7 | As the old role: `GRANT sipges_app TO mascli_workers WITH INHERIT TRUE, SET TRUE;` | 1 s | 0 |
| R5 | `gh secret set SIPGES_MIGRATION_DATABASE_URL --env production < "$DIR/old.url"` | No | n/a |
| R4 | `wrangler hyperdrive update <id> --connection-string="$(cat "$DIR/old.url")"`. Works with or without R7 | 3 s | 0 |
| R3 | **Functions first, then tables**: step 3 with the two role names swapped, until nothing is left. Needs R7 | 6 to 13 s | 0 |
| R2 | The step 2 `PATCH` with `"owner_name":"mascli_workers"` | 1 s | 0 |
| R1 | `REVOKE sipges_tenant FROM sipges_app; REVOKE sipges_app FROM mascli_workers; DROP ROLE sipges_app;` | 1 s | 0 |

R3 order is not cosmetic: tables first left the history trigger running as a role with no rights on `record_versions`, and one write answered `500`. Functions first failed none. If `DROP ROLE` reports dependent objects, R3 did not finish; go back to it.

### Last resort: Neon restore

Use it only if data is damaged, because **everything written after the restore point is lost**, sessions included: users must sign in again.

```bash
neon branches restore main pre-role-cutover --project-id "$NEON_PROJECT_ID" \
  --preserve-under-name main-before-restore
```

- It took 5 s, the connection string stayed the same, and it was one `500` plus `401`s for sessions newer than the restore point.
- `main` has children, so Neon requires the preserve name. If the CLI refuses the source, restore `main` to its own history at the time in `before.txt`: `^self@<time>`. The window is 6 hours on this project.
- Check the login right after: on one of two restores the role's password no longer matched. Reset it with the Neon API on that branch, and update Hyperdrive.
- **Not rehearsed on a root branch.** The rehearsal restored a child branch from a sibling's head.
- A source branch loses any expiry it had, and it cannot get one back while it has children. Delete it by hand.

## Migrations under the new role

| Case | Result as `sipges_app` |
| --- | --- |
| `migrate` at deploy, nothing pending | Works |
| `CREATE TABLE` with RLS and policy, `ADD COLUMN`, index, function, grant to `sipges_tenant` | Works |
| `CREATE EXTENSION pg_trgm`, `vector` | Worked as database owner |
| `CREATE ROLE` | Refused. The migrations create roles only on an empty database: see [readiness](readiness.md#3-postgresql-with-a-least-privilege-role) |
| `UPDATE` on a forced-RLS table, no tenant | **0 rows, no error** |
| Same, after `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` | All rows |

**The last two matter most.** `mascli_workers` bypassed RLS, so a data migration simply worked. Under `sipges_app` the same SQL does nothing, silently, and the migration is recorded as applied. Every future migration that rewrites rows must lift `FORCE` and restore it, as `0030` and `0031` do. None is pending today. No check enforces this yet.

## Is renaming the database worth it?

**No, not as part of this cutover.** It removes a name from a connection string and changes nothing else. `mascli_workers` the role stays anyway, since it cannot be deleted.

| Measured | Result |
| --- | --- |
| Rename under traffic | The API answered `200`, then **cancelled it silently**. The compute restarted, one `500`, a 5 s stall, and the name did not change |
| Rename with no traffic | Worked in 5 s |
| Hyperdrive before the rename | Refused: `The specified database name does not exist` |
| Hyperdrive after the rename | The site is down until it lands: `500` and `503` on every database route |

So it needs traffic stopped, and no maintenance mode exists, and it cannot be prepared ahead. It also changes three strings: Hyperdrive, `SIPGES_MIGRATION_DATABASE_URL`, and `SIPGES_GO_DATABASE_URL`. If the owner still wants it, per [T59](../../odd/tasks/go-rust-stack.md), it is a separate, announced window of about a minute of downtime.

## Rehearsal results

A Neon branch of `main` with an expiry, 0.25 CU like production, and a throwaway Worker on a Hyperdrive of its own, with no cron at first and an empty bucket. The Worker, its Hyperdrive and bucket, and both branches were deleted afterwards. Production's branch, roles and Hyperdrive login were read, not written.

**Traffic:** readiness, session lookup and a tenant read each per second, a create and delete every 3 s, and a sign-in every 20 s.

| Result | Evidence |
| --- | --- |
| Final order, forward | 0 failed probes across the run. Steps took 29 s |
| Browser walk over the same run | 82 visits to six screens: 12 flags were the page's own INGEMMET notice, one was real, the forced restart |
| Hyperdrive, either way, in place | 2.8 to 3.2 s, 0 failed |
| Old role serving after losing ownership | 0 failed, including writes and sign-ins |
| Reads, old role against new | 57 GET routes on both projects, 114 requests: same status on all, identical bodies on 104. Nine carry timestamps or counters and vary on their own; one `/system/audit` differed in content at the same size, after probe writes |
| History trigger after the handover | Kept writing `record_versions` |
| Real cron under `sipges_app` | Both projects `completed`. The rehearsal database had no rules, channels or keys, so nothing was sent |
| Compute restart | 5 s, and 4 `500`s in the browser |

**Failures, and what changed:**

| Failure | Change |
| --- | --- |
| `REASSIGN OWNED` deadlocked 10 of 10 | Step 3 |
| `ALTER … OWNER` refused: `permission denied for schema public` | Step 2 comes first |
| Compute restart reverted the database owner | Step 2 uses the API |
| Rollback, tables first: one `500` | R3 moves functions first |
| Rollback hit two lock timeouts | Rerun until nothing is left |
| Drain check answered 0 as `sipges_app` | Step 4 asks as the old role |
| Deleting the old role took down tenant routes | The warning in step 9 |
| A branch with an expiry refused a child restore point | The restore was rehearsed from a sibling; production's has no expiry |

## Open risks

1. **The tests do not run as this role.** CI uses `postgres`, a superuser, so a path that reads a forced table outside a tenant transaction would return nothing here and pass there. The read sweep covers GET routes, and the trial ran on `sipges_app`, but write routes have no equivalent sweep.
2. **`mascli_workers` keeps `BYPASSRLS` until step 9**, and permanently as a role. Only the password protects it.
3. **`sipges_app` depends on a grant from `mascli_workers`.** One careless delete in the console is an outage with no SQL repair.
4. **Load was light and the data small.** 3.3 requests per second on 23 MB. Quiet hours are still the plan.
5. **`gh secret set`, the production restore and step 9 under traffic were not rehearsed.**
6. **The rehearsal's sign-in used no MFA and uploaded no file.** Neither depends on the role, and Hyperdrive and R2 are separate.
7. **Go is not part of this.** `SIPGES_GO_DATABASE_URL` must use the same role, per the [go-live list](go-trial-runbook.md#go-live-list-names-never-values).

## Sources

- [Neon: manage roles](https://neon.com/docs/manage/roles), [instant restore](https://neon.com/docs/guides/branch-restore), [history window](https://neon.com/docs/postgres/backup-restore/history-window)
- [PostgreSQL: `REASSIGN OWNED`](https://www.postgresql.org/docs/current/sql-reassign-owned.html), [predefined roles](https://www.postgresql.org/docs/current/predefined-roles.html)
- [Wrangler: Hyperdrive commands](https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/)
