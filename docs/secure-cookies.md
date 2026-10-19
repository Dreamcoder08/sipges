# Secure session and project cookies by default

Both `mascli_session` (login) and `mascli_scope` (project selection) now use a single, strict startup policy. This is a bounded security correction, **not production readiness or deployment approval**.

## Choose the transport before starting

| `MASCLI_COOKIE_SECURE` | Result |
|---|---|
| Unset | `Secure` enabled; use HTTPS |
| Exactly `1` | `Secure` enabled; use HTTPS |
| Exactly `0` | `Secure` disabled; intentional local loopback HTTP only |
| Anything else, including empty, whitespace, `true`, or `01` | Import fails with a configuration error before app/resource initialization |

The policy is evaluated once at import. Restart the process after changing it; request headers and later environment changes do not override it. Neither value creates TLS: HTTPS must be provided by the deployment endpoint. Do not set `0` on a public service.

## Local HTTP quick path

The four loopback launchers (`start_mascli.bat`, `INICIAR_MASCLI_FINAL.bat`, `start_mascli.sh`, `iniciar_mascli_final.sh`) supply `0` **only when the variable is absent**. They preserve explicit `1` and invalid values. An explicit `1` on their HTTP listener prevents normal authenticated follow-up; choose HTTPS or intentionally set `0` for local testing.

For direct local commands, set the override yourself:

```powershell
$env:MASCLI_COOKIE_SECURE="0"
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

```bash
MASCLI_COOKIE_SECURE=0 python3 -m uvicorn app:app --host 127.0.0.1 --port 8000
```

### Empty environment values

Bash distinguishes unset from empty using `${MASCLI_COOKIE_SECURE+x}`; an exported empty value is preserved and rejected by the app. `cmd.exe` normally removes a variable with `set "MASCLI_COOKIE_SECURE="`, and `IF DEFINED` cannot reliably distinguish an inherited empty value. The batch launchers therefore use Python's `os.environ.setdefault` inside the child process, not `IF DEFINED`: an inherited empty value that reaches Python is preserved and rejected. If the calling shell/OS has already removed it, it is absent and receives the local override. Shells/PowerShell versions may differ in whether they retain empty environment entries; use exact `0` or `1`, not empty as a configuration choice.

## Cookie contract and verification

Names, eight-hour Max-Age, `/` path, HttpOnly, SameSite=Strict and host-only behavior remain unchanged. Logout behavior is unchanged. Secure cookies are not transported over HTTP by the synthetic client; tests deliberately avoid browser-specific loopback exceptions. Scope selection tests authenticate and follow up using cookies alone, without `X-MASCLI-Scope`.

`tests/test_secure_cookies.py` uses synthetic temporary databases, seed/config paths and HTTP/HTTPS TestClient URLs. It covers default/explicit policies, both headers, authenticated follow-up, scope switching, HTTP non-transport, denied selections, startup-static configuration and invalid-config rejection before initialization. Existing synthetic HTTP tests still explicitly select `0`.

## Remaining deployment blockers

- Durable private storage for global auth, tenant databases, mutable settings and uploads is not implemented; Render Free local storage is ephemeral.
- MFA policy/recovery, login throttling and further CSRF/host/request hardening remain separate security work.
- Provider accounts, private-storage permissions, HTTPS/live authorization and restart-persistence validation remain unverified.

Keep source private and do not upload operational seeds, personal records or credentials. See [the preparation task](../odd/archive/python-free-hosting-preparation.md) for the broader plan; this change does not authorize a public rollout or real-data migration.
