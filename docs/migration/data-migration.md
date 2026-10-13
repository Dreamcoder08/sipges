# Legacy data migration (T13)

Tooling that moves a legacy MASCLI RC 3.0 installation (SQLite + JSON + upload files) into the
TypeScript API's PostgreSQL schema. The legacy installation is only ever **read**; the tool opens
every SQLite file read-only and never writes to the old data directory.

Validated on synthetic data only. No real or operational database has been migrated, and the
ODD forbids doing so without an explicit user decision.

- Code: `apps/api/src/tools/migrate-legacy/` (`domain/` pure mapping, `application/` use case
  and ports, `infrastructure/` SQLite reader and PostgreSQL writer, `cli.ts`).
- Command: `pnpm --filter @mascli/api migrate:legacy -- --legacy-root <dir> [...]`.
- Tests: `apps/api/test/migration/*`, `apps/api/test/integration/migration-postgres.test.ts`.

## What the tool reads

| Legacy source | Target |
| --- | --- |
| `auth_global.db` → `auth_users` | `users` (password hash kept as legacy PBKDF2; TOTP secret sealed with `MASCLI_DATA_KEY`) |
| `auth_global.db` → `tenant_projects` | `tenants` |
| `auth_global.db` → `access_grants` | `grants` |
| `auth_global.db` → `auth_sessions` | **not migrated** (counted only) |
| `data/mascli.db` (scope `MASCLI/PRJ-SECHURA`) and `TENANT_DIR/<sha256("company/project")[:24]>.db` | the tenant's business tables |
| `records` | `module_records` (ids, timestamps and the full payload, unknown fields included) |
| `audit` | `audit` (ts, module, record id, action, detail) |
| `irsa_snapshots` | `irsa_snapshots` |
| `irsa_config.json` (`data/` or `TENANT_DIR/<digest>_settings/`) | `irsa_configs` |
| `attachments` + `UPLOAD_DIR[/<digest>]/<stored_name>` | `attachments` + object storage (bytes copied through the ObjectStorage port, sha256 verified) |
| `document_review`, `digital_alert_reviews`, `preventive_actions`, `preventive_action_log` | same tables |

## What is **not** migrated

- **Sessions.** Everyone signs in again after the cut-over; `auth_sessions` is only counted.
- **Surrogate ids of `audit` and `irsa_snapshots`.** They are per-file autoincrement values in
  SQLite and would collide between tenants in the shared PostgreSQL tables. Rows are inserted in
  legacy id order, so history keeps its sequence; every business id (`records`, `attachments`,
  `document_review`, alerts, actions, log entries) is preserved verbatim.
- **Other JSON configuration** (`indicator_config.json`, `model_status.json`,
  `canonical_entities.json`, `project_coordinates.json`, `seed.json`). They are reference data
  shipped with the application, not tenant state; only `irsa_config.json` is editable per scope.
- **Legacy `auth_users` rows that may sit inside a tenant database** (behavior contract §8.7).
  Accounts come from `auth_global.db` only.
- **Rows the new schema refuses**: unknown role, malformed password hash, payload that is not a
  JSON object, NUL characters (PostgreSQL text/jsonb cannot store them), status values outside
  the documented state machines, attachments whose file is missing or whose sha256 does not match
  the bytes, preventive actions without their alert. Each one is reported with its code, table and
  identifier, and nothing else about it.

Timestamps are naive local strings in SQLite (`datetime.now().isoformat`). They are read as
**UTC**. If the legacy server ran in another timezone, the operator must decide whether to shift
them before the cut-over.

## Runbook

### 1. Back up

Stop the legacy app, then copy the whole legacy `data/` directory (databases, JSON configuration
and uploads). Back up the target PostgreSQL database as well, even when it is empty. The tool
never writes to the legacy side, but a backup is what makes the rollback below trivial.

### 2. Configure the target

The tool uses the API configuration: `MASCLI_DATABASE_URL` (or `MASCLI_PGLITE_DIR` for a local
trial), `MASCLI_DATA_KEY` (the same key the API runs with — it seals migrated TOTP secrets) and
the object storage settings (`MASCLI_STORAGE`, `MASCLI_UPLOAD_DIR` or the S3 variables). Pending
schema migrations are applied before anything is read.

### 3. Dry run

```
pnpm --filter @mascli/api migrate:legacy -- --legacy-root /srv/mascli-legacy
```

Nothing is written. The summary gives per tenant `source / mapped / written / target` row counts
and the copied/verified object counts, followed by the problem codes. Resolve or accept every
problem before applying; the process exits non-zero while any error-level problem remains.

Useful flags: `--only MASCLI/PRJ-SECHURA` (repeatable), `--report report.json`, and the path
overrides `--auth-db`, `--default-db`, `--tenant-dir`, `--upload-dir`, `--config-dir` for
installations that used the matching `MASCLI_*` environment variables.

### 4. Apply

```
pnpm --filter @mascli/api migrate:legacy -- --legacy-root /srv/mascli-legacy --apply --report apply.json
```

Global rows (tenants, users, grants) are written in one transaction; each tenant's business
tables are written in one `withTenant` transaction under forced RLS, so a tenant is migrated
completely or not at all. Attachment bytes are copied before the tenant transaction under a
deterministic object key.

The run **refuses a non-empty target**: if the users table already holds accounts or any tenant
already holds rows, it reports `target_not_empty` and writes nothing. `--allow-non-empty` is the
explicit override (for example when the API has already bootstrapped its admin account, or to
resume an interrupted run). With it, keyed tables skip rows that already exist; `audit` is
append-only and would be duplicated, so prefer restoring the backup over repeating a run that
already wrote audit rows.

### 5. Verify

```
pnpm --filter @mascli/api migrate:legacy -- --legacy-root /srv/mascli-legacy --verify --report verify.json
```

Verify re-reads the legacy installation and compares, per tenant: row counts per table, an
order-independent checksum over every record (`module`, id, canonical payload), and the sha256 of
every attachment object fetched back through the storage port. Mismatches appear as
`verify_count_mismatch`, `verify_checksum_mismatch`, `verify_attachment_missing` or
`verify_attachment_mismatch`. The rows the source itself cannot migrate are reported again, so a
clean verification means: no `verify_*` code, and the same problem list as the dry run.

Then check the application: sign in with a migrated account (the legacy password still works and
is transparently rehashed to Argon2id), open a couple of records, download an attachment and run
`GET /system/export`.

### 6. Roll back

Nothing in the legacy installation changed, so a rollback is: stop the new API, restore the
target database from the backup taken in step 1 (or drop and re-create it and re-run the schema
migrations), delete the copied objects from the storage bucket/directory, and start the legacy
app again. Users sign in again in either direction, because sessions are never migrated.

## Logging and secrets

The summary and the JSON report contain counts, problem codes, table names and identifiers only.
Record payloads, excerpts, password hashes and TOTP secrets are never logged, never written to a
report and never returned by the port that reads them. The migration tests assert this against
marker strings planted in the synthetic fixture.

## Tests

`apps/api/test/support/legacy-fixture.ts` builds a synthetic legacy installation whose SQLite
tables are created with the `CREATE TABLE` statements extracted from `app.py`, so the fixture
cannot drift from the schema it claims to migrate. It contains two tenants, two migratable
accounts (one with TOTP), uploads on disk and deliberately broken rows.

- `test/migration/mapping.test.ts` — pure mapping: timestamps, NUL rejection, hash formats,
  module slug to stored module name, deterministic object keys, checksums.
- `test/migration/migrate-legacy.test.ts` — dry-run writes nothing, apply/verify, re-run refusal,
  idempotent keyed tables, redaction of the summary and report.
- `test/migration/migrated-app-http.test.ts` — through the real HTTP app: login with a legacy
  PBKDF2 hash (and the migrated TOTP enrolment), scoped record lists, tenant isolation 403/404
  (S7), attachment download byte-for-byte, IRSA config/history and `GET /system/export`.
- `test/integration/migration-postgres.test.ts` — the same migration against a real PostgreSQL
  server (opt-in with `MASCLI_TEST_DATABASE_URL`).

## Driver note (fixed here)

postgres.js learns the server-inferred parameter type after `Parse` and then applies its own JSON
serializer. Repositories pass JSON **text** for `json`/`jsonb` parameters, which was therefore
encoded a second time on a real PostgreSQL server and stored as a JSON string, breaking
`CHECK (jsonb_typeof(payload) = 'object')` for every record, attachment payload update, alert and
IRSA write. `platform/database/postgres.ts` now registers a pass-through serializer for types 114
and 3802; `test/integration/migration-postgres.test.ts` asserts `jsonb_typeof(payload) = 'object'`
after a migration. PGlite was never affected, which is why the defect only surfaced here.
