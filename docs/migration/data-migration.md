# Legacy data migration (T13)

Tooling that moves a legacy SIPGES RC 3.0 installation (SQLite + JSON + upload files) into the
TypeScript API's PostgreSQL schema. The legacy installation is only ever **read**; the tool opens
every SQLite file read-only and never writes to the old data directory.

Validated on synthetic data only. No real or operational database has been migrated, and the
ODD forbids doing so without an explicit user decision.

- Code: `apps/api/src/tools/migrate-legacy/` (`domain/` pure mapping, `application/` use case
  and ports, `infrastructure/` SQLite reader and PostgreSQL writer, `cli.ts`).
- Command: `pnpm --filter @sipges/api migrate:legacy -- --legacy-root <dir> [...]`.
- Tests: `apps/api/test/migration/*`, `apps/api/test/integration/migration-postgres.test.ts`.

## What the tool reads

| Legacy source | Target |
| --- | --- |
| `auth_global.db` → `auth_users` | `users` (password hash kept as legacy PBKDF2; TOTP secret sealed with `SIPGES_DATA_KEY`) |
| `auth_global.db` → `tenant_projects` | `tenants` |
| `auth_global.db` → `access_grants` | `grants` |
| `auth_global.db` → `auth_sessions` | **not migrated** (counted only) |
| `data/sipges.db` (scope `SIPGES/PRJ-SECHURA`) and `TENANT_DIR/<sha256("company/project")[:24]>.db` | the tenant's business tables |
| `records` | `module_records` (ids, timestamps and the full payload, unknown fields included) |
| `audit` | `audit` (ts, module, record id, action, detail) |
| `irsa_snapshots` | `irsa_snapshots` |
| `irsa_config.json` (`data/` or `TENANT_DIR/<digest>_settings/`) | `irsa_configs` (a tenant without its own file gets the default scope's `data/irsa_config.json`, exactly what app.py `scoped_config` copies on first use; reported as `irsa_config_inherited`, info) |
| `attachments` + `UPLOAD_DIR[/<digest>]/<stored_name>` | `attachments` + object storage (bytes copied through the ObjectStorage port, sha256 verified). A `stored_name` must be one path component (no `/`, `\`, `..` or NUL; app.py writes `<uuid hex>_<safe name>`) and a regular file: symlinks are never followed, because the default scope's upload root also holds every other tenant's folder (`attachment_stored_name_unsafe` / `attachment_object_missing`) |
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
  Exception: `seed.json` is the prototype's Base Maestra, which app.py loaded into an empty
  database; load it explicitly with `import:base-maestra` (docs/migration/base-maestra.md).
- **Legacy `auth_users` rows that may sit inside a tenant database** (behavior contract §8.7).
  Accounts come from `auth_global.db` only.
- **Rows the new schema refuses**: unknown role, malformed password hash, payload that is not a
  JSON object, NUL characters in any migrated text or JSON value (PostgreSQL text/jsonb cannot
  store them), alerts whose `themes_json`/`signals_json`/`suggestions_json` app.py could not
  `json.loads` or whose `reviewed_at` is not a timestamp (`alert_row_invalid`), status values
  outside the documented state machines, attachments whose file is missing or whose sha256 does not match
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

Run the migration **before the API starts for the first time**, against an empty database. On
its first start the API bootstraps an `admin` account (`SIPGES_ADMIN_USERNAME`), the default
tenant and that account's grant; a later migration cannot replace them (see step 4). If the API
has already started, restore the empty backup (or drop and re-create the database) first.

The tool uses the API configuration: `SIPGES_DATABASE_URL` (or `SIPGES_PGLITE_DIR` for a local
trial), `SIPGES_DATA_KEY` (the same key the API runs with — it seals migrated TOTP secrets) and
the object storage settings (`SIPGES_STORAGE`, `SIPGES_UPLOAD_DIR` or the S3 variables). Pending
schema migrations are applied before anything is read.

### 3. Dry run

```
pnpm --filter @sipges/api migrate:legacy -- --legacy-root /srv/sipges-legacy
```

Nothing is written. The summary gives per tenant `source / mapped / written / target` row counts
and the copied/verified object counts, followed by the problem codes. Resolve or accept every
problem before applying; the process exits non-zero while any error-level problem remains.

Useful flags: `--only SIPGES/PRJ-SECHURA` (repeatable), `--report report.json`, and the path
overrides `--auth-db`, `--default-db`, `--tenant-dir`, `--upload-dir`, `--config-dir` for
installations that used the matching `SIPGES_*` environment variables.

### 4. Apply

```
pnpm --filter @sipges/api migrate:legacy -- --legacy-root /srv/sipges-legacy --apply --report apply.json
```

Global rows (tenants, users, grants) are written in one transaction; each tenant's business
tables are written in one `withTenant` transaction under forced RLS, so a tenant is migrated
completely or not at all. Attachment bytes are copied before the tenant transaction under a
deterministic object key.

The run **refuses a non-empty target**: if the users table already holds accounts or any tenant
already holds rows, it reports `target_not_empty` and writes nothing. Do not use
`--allow-non-empty` to get past an API-bootstrapped admin: start from an empty database instead.

If one tenant fails (constraint, connection, storage), its transaction rolls back, the report
records `tenant_write_failed` with the tenant id only (no driver message, which could quote
data), the remaining tenants are still applied, the report is still written and the process
exits 1. Objects already copied for the failed tenant stay under their deterministic keys and
are reused by the next attempt.

`--allow-non-empty` is the explicit override for **resuming** such a run. With it:

- every tenant whose business tables already hold rows is skipped as a whole and reported as
  `tenant_not_empty` (error): `audit` and `irsa_snapshots` have generated keys, so writing a
  tenant twice would duplicate them; a tenant that committed in an earlier run is complete,
  because each tenant is one transaction;
- every keyed row whose key already exists — users, tenants, grants and any keyed tenant table —
  is left as it is in the target and reported as `row_already_present` (error, with table and
  key). This is also how a bootstrap admin conflict surfaces: the target keeps the bootstrap
  hash, role and TOTP state instead of the legacy account's, so fix that account (or start
  from an empty database) before going live.

A resumed run therefore always exits 1 for the rows of the earlier run; `--verify` (step 5) is
what proves the result.

### 5. Verify

```
pnpm --filter @sipges/api migrate:legacy -- --legacy-root /srv/sipges-legacy --verify --report verify.json
```

Verify re-reads the legacy installation and compares, per tenant: row counts per table, an
order-independent checksum of the canonical rows of **every** tenant table (`module_records`,
`audit`, `irsa_configs`, `irsa_snapshots`, `attachments` metadata, `document_review`,
`digital_alert_reviews`, `preventive_actions`, `preventive_action_log`: every migrated column,
timestamps normalized to UTC, generated `audit`/`irsa_snapshots` ids excluded), and the sha256 of
every attachment object fetched back through the storage port. It also compares the migrated
accounts (username, full name, password hash, role, active, TOTP enabled/present), tenants
(label) and grants by key. Mismatches appear as `verify_count_mismatch`,
`verify_checksum_mismatch` (with the table), `verify_attachment_missing`,
`verify_attachment_mismatch`, `verify_user_missing`, `verify_user_mismatch`,
`verify_tenant_missing`, `verify_tenant_mismatch` and `verify_grant_missing`; accounts or grants
of a migrated tenant that the legacy installation does not have are listed as
`verify_row_unexpected` (warning). Run verify right after apply: once users sign in, their
PBKDF2 hashes are rehashed to Argon2id and `verify_user_mismatch` is expected. The rows the source itself cannot migrate are reported again, so a
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

- `test/migration/mapping.test.ts` — pure mapping: timestamps, NUL rejection on every output
  text field, alert JSON/review date rejection, safe stored names, hash formats,
  module slug to stored module name, deterministic object keys, checksums.
- `test/migration/migrate-legacy.test.ts` — dry-run writes nothing, apply/verify, re-run refusal,
  `--allow-non-empty` (whole-tenant skip, `row_already_present` for a bootstrapped account and
  `verify_user_mismatch`), per-table verify checksums against edited target rows, a failing
  tenant reported and resumed without duplicates, inherited IRSA configuration, upload reads that
  refuse other tenants' folders and symlinks, redaction of the summary and report.
- `test/migration/migrated-app-http.test.ts` — through the real HTTP app: login with a legacy
  PBKDF2 hash (and the migrated TOTP enrolment), scoped record lists, tenant isolation 403/404
  (S7), attachment download byte-for-byte, IRSA config/history and `GET /system/export`.
- `test/integration/migration-postgres.test.ts` — the same migration against a real PostgreSQL
  server (opt-in with `SIPGES_TEST_DATABASE_URL`).

## Rust port

`engines/crates/migrate-legacy` is the Rust port of this tool (ADR 0032, T43): same flags, summary,
JSON report, exit codes, rows and objects. The workflows still call the TypeScript tool, and a
real run needs the owner's word whichever one is used.

```sh
cd engines && cargo build --release -p sipges-migrate-legacy
target/release/migrate-legacy --legacy-root /srv/sipges-legacy --report report.json
```

`engines/tools-parity/migrate-legacy.ts` runs both tools on synthetic installations (one synthetic
database and object store each) and compares exit code, stdout, stderr, the report, every table and
every object. It covers refusals, the whole flow, `--only`, hostile rows, tampered targets, failing
tenants, damaged SQLite files and S3 through a local server that checks each request's signature.
`engines/fixtures/legacy-dates.tsv` pins the port of V8's date parser to values recorded from Node.

| Case | TypeScript | Rust |
| --- | --- | --- |
| `SIPGES_DATABASE_URL` unset | embedded PGlite | refuses, exit 1 |
| Other API settings invalid (only the data key, database URL and storage settings are read) | `loadConfig` fails, exit 1 | ignored |
| A failure TypeScript does not catch | exit 1 with a stack trace, whose message may quote a driver | exit 1 with the error's name and at most an operator's path |
| A timestamp text with no zone that ends like an offset, such as `01-02-2026` | local time of the process | UTC (the same under `TZ=UTC`) |
| A payload, scores or configuration nested 1,001 to about 2,500 levels | migrated | `RangeError`, exit 1 before any write (TypeScript overflows from about 2,500 levels, at a depth that varies with the stack) |
| An alert JSON column nested 1,001 to about 2,500 levels | migrated | `alert_row_invalid` |
| JSON nested past 100,000 levels with a syntax error | row rejected | `RangeError`, exit 1 |
| A `0x`, `0o` or `0b` number longer than 128 bits | exactly rounded | accumulated in floating point |
| `SIPGES_S3_ENDPOINT` with credentials, without `//` or with characters outside host syntax | accepted by `new URL` | refused, exit 1 |
| An S3 redirect | followed | not followed: the reply counts as a failure |
| TLS to PostgreSQL | encrypts without verifying | verifies against the Mozilla roots |
| Connection lost mid-run | a new connection, from a pool | a new connection, one at a time |

## Driver note (fixed here)

postgres.js learns the server-inferred parameter type after `Parse` and then applies its own JSON
serializer. Repositories pass JSON **text** for `json`/`jsonb` parameters, which was therefore
encoded a second time on a real PostgreSQL server and stored as a JSON string, breaking
`CHECK (jsonb_typeof(payload) = 'object')` for every record, attachment payload update, alert and
IRSA write. `platform/database/postgres.ts` now registers a pass-through serializer for types 114
and 3802; `test/integration/migration-postgres.test.ts` asserts `jsonb_typeof(payload) = 'object'`
after a migration. PGlite was never affected, which is why the defect only surfaced here.
