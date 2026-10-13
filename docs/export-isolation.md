# Scoped SQLite export regression

## Contract

`GET /system/export` exports the database selected by the authenticated,
authorized project scope, not the global default database. The endpoint captures
`SCOPE_DB` eagerly before returning `FileResponse`; middleware resets the context
after handling the request, while file delivery can continue afterward. A missing
scope raises HTTP 403 rather than falling back to the global database.

The existing middleware still owns authentication, grant checks, administrator
access, and the HTTP 503 response for an uninitialized tenant database. The
attachment filename remains `mascli.db` and its media type remains
`application/octet-stream`. No authentication or frontend behavior is changed.

## Safe test setup

`tests/test_export_scope.py` imports the real FastAPI application and runs its
middleware and startup using `TestClient`. Before importing the application, it
redirects operational DB, auth DB, tenant directory, and upload directory paths
to pytest temporary directories. Before startup, it replaces `SEED` with a
synthetic JSON fixture and redirects all configuration-file paths. It does not
read the original seed or initialize/open operational databases.

The fixture creates two synthetic tenant databases with distinct markers and
synthetic users/grants. Tests verify the default scope, both tenant markers with
exclusion of every other marker, sequential scope switches, anonymous 401,
non-admin 403, ungranted 403, missing scope 403, missing tenant database 503, and
a direct endpoint call without scope. Denied responses contain neither marker
data nor a download header; the missing database is not created.

## Verification

The existing ignored `.venv` supplied the runner; no installation was needed.
`requirements-test.txt` includes `requirements.txt` and pins `pytest==8.3.5` and
`httpx==0.28.1`. On Windows Git Bash, the observed command was:

```bash
export PYTHONDONTWRITEBYTECODE=1 PYTEST_ADDOPTS='-p no:cacheprovider'; .venv/Scripts/python.exe -m pytest tests/test_export_scope.py -q
```

These environment settings avoid repository bytecode and pytest cache writes.
Before changing the endpoint, the recovered tests produced **4 failed, 6 passed**:
both tenant downloads, sequential switching, and the direct missing-scope check
failed. After the endpoint correction, the identical command produced
**10 passed**. Both runs emitted 21 deprecation warnings from the existing
FastAPI startup API and Starlette/httpx integration; they were not test failures.

Additional checks use `git diff --check` and in-memory `ast.parse` of `app.py`
and `tests/test_export_scope.py`, without importing or starting the application.
This verification concerns only export isolation, not production hosting,
durability, migrations, or broader authentication hardening.
