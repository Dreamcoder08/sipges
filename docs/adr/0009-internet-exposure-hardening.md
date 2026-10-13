# 0009 — Internet exposure hardening

## Context
The secure-deployment plan (`odd/tasks/secure-mascli-public-deployment.md`) publishes MASCLI on the internet behind Cloudflare Tunnel + Access. Several gaps from the Python review were still open in the TypeScript API: an absent `Origin` header skipped the CSRF check, no CSP was sent, any `Host` was accepted, MFA was optional, and a lost authenticator could not be recovered because setup returns 409 once MFA is enabled (ADR 0004).

## Decision
1. **Origin rule.** Every state-changing request must name this host in `Origin`, or in `Referer` when a browser omits `Origin`. A request with neither, or with `Origin: null`, gets 403. Non-browser clients send `Origin: https://<host>`.
2. **API CSP.** Every response carries `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` and a restrictive `Permissions-Policy`. This covers JSON and the server-rendered `/select-project` form, which has inline style attributes and no scripts. The SPA keeps its own policy (ADR 0006, T11).
3. **Host allowlist.** `MASCLI_ALLOWED_HOSTS` (comma-separated host names) answers 400 to any other `Host`. It is empty by default for local development and must be set in deployments.
4. **Mandatory MFA.** `MASCLI_REQUIRE_MFA` defaults to on (exactly `0` or `1`, like `MASCLI_COOKIE_SECURE`). A session whose user has not enrolled TOTP gets `403 {detail, mfa_required: true}` everywhere except `/system/auth/totp/setup` and `/system/auth/totp/enable`. Public routes (`/system/auth/me`, `/logout`) keep working.
5. **Enrollment is self-service.** Those two routes are allowed for every role and do not need a project grant. This differs from the Python policy, where `consulta` and `coordinador` got 403, which would lock them out once MFA is mandatory.
6. **MFA reset.** `POST /system/auth/accounts/:username/reset-mfa` (admin only, scope-free, origin-checked) clears the factor and deletes the user's sessions in one transaction. An administrator cannot reset their own MFA, so a stolen admin session cannot remove the factor. A sole administrator is recovered on the server with `node src/admin-cli.ts reset-mfa <username>`.

## Consequences
- Scripts and integrations must send an `Origin` header on writes.
- New installations require every user, including the bootstrap admin, to enroll an authenticator at first login. Test suites set `MASCLI_REQUIRE_MFA=0` except where enforcement is under test.
- Server access is the trust anchor for recovering a sole administrator.
- Tests: `apps/api/test/identity/deployment-hardening.test.ts`.

## References
OWASP ASVS 4.0 V2.8, V3.5, V4.2 and V14.4; OWASP CSRF Prevention Cheat Sheet (Origin/Referer verification); RFC 6454.
