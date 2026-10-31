# Explicit-path SQLite connections (P4a)

This is a SQLite-only extraction, not a remote backend, data migration, or
hosted-durability solution. Python and the existing SQLite SQL remain unchanged.
No provider connection, schema change, or operational data transfer is included.

## Connection contract

`storage_sqlite.connect_sqlite(path, *, dictionary_rows=False)` opens a new
standard-library `sqlite3.Connection` for the supplied string or path object.
The helper has no global database path and opens nothing on import. It does not
create directories, inspect credentials, select a backend, resolve tenants,
route requests, or pool connections.

- SQLite timeout, isolation and thread-policy defaults are preserved by passing
  only the explicit path to `sqlite3.connect`.
- Rows are tuples by default. `dictionary_rows=True` selects `sqlite3.Row`,
  retaining both column-name and positional access; it does not return dicts.
- The native connection context manager commits on successful exit and rolls
  back pending transactions on exceptional exit. It does **not** close the
  connection. Callers must still close connections explicitly.

## Caller-owned paths and scoping

`app.py` still creates the authentication parent directory and opens `AUTH_DB`.
Authentication and business connections request named rows. Business connections
still resolve `SCOPE_DB.get() or DB`, preserving the legacy fallback exactly.
That fallback is not an authorization guarantee: scope resolution, access checks,
and any future fail-closed policy remain the caller's responsibility.

Tenant provisioning passes its target path and the original `DB` explicitly.
Both connections retain tuple rows, including the single-column schema-definition
iteration. Existing commit and close points are unchanged. Startup, bootstrap,
seed handling, middleware, and scoped exports are not modified by this unit.

## Verification and remaining blockers

`tests/test_storage_sqlite.py` uses temporary synthetic databases to verify row
shapes, same-table/same-ID path isolation, commit persistence after reopening,
rollback on exceptions, and connection lifetime after context exit. Existing
export and MFA regressions remain part of the focused test command.

Remote authentication and business persistence, complete schema/parity work,
mutable settings, private uploads, and SQLite-compatible remote exports remain
separate blockers. A disposable hosted filesystem is not durable SQLite storage.
Provider ownership, private access, free-tier capacity, restart persistence,
and any real-data cutover still require separate authorization and verification.
