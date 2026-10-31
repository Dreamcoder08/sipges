> **Superseded for the TypeScript API by [ADR 0009](../../../docs/adr/0009-internet-exposure-hardening.md)**: MFA is mandatory by default, every role can enroll, and administrators can reset another user's MFA.

# MFA enrollment reset protection (P2a)

`POST /system/auth/totp/setup` now updates only an account whose
`totp_enabled` is zero. The conditional SQLite UPDATE checks its affected-row
count atomically; no matching account returns HTTP 409 without an enrollment
secret or URI. The connection closes on success and rejection.

Initial setup and retries before enablement still return HTTP 200 with a new
secret, enrollment URI and instruction. Once `/system/auth/totp/enable` succeeds,
even the retained session cannot replace the secret or disable MFA through
setup. Subsequent login still requires the original authenticator code.

Existing middleware policy is unchanged: anonymous setup returns 401;
`consulta` and `coordinador` return 403; `analista` can enroll. Multi-grant
administrators must supply an authorized scope, as before.

## Isolated verification

The shared fixture in `tests/conftest.py` redirects database, authentication,
tenant and upload environment paths before importing the app. It replaces the
seed and configuration paths with synthetic temporary resources before startup.
No operational seed or database is used. Tests exercise real login, setup,
enablement, retained-session rejection and subsequent MFA login.

Run from the repository root using the existing virtual environment:

```bash
PYTHONDONTWRITEBYTECODE=1 PYTEST_ADDOPTS='-p no:cacheprovider' .venv/Scripts/python.exe -m pytest tests/test_export_scope.py tests/test_totp_setup.py -q
```

Observed test-first results:
- RED against original setup: 1 failed, 15 passed; enabled-account setup returned
  200 instead of 409.
- GREEN with guard: 16 passed, including all 10 existing export cases and 6 MFA
  cases. Both runs reported 33 existing dependency/startup deprecation warnings.

This is only P2a, not complete MFA hardening or deployment readiness. MFA remains
optional; recovery/reset policy, login abuse protection, production cookie and
request defenses, persistence and deployment verification remain separate work.
No schema, login, enablement, role policy, recovery or UI behavior was changed.
