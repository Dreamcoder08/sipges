# 0004 — Identity and session security

## Context
Behavior contract §2 and §8.8: PBKDF2-SHA256 (310k) hashes, opaque sessions stored as SHA-256, TOTP secrets in plaintext, no replay protection, no login throttling, no session purge.

## Decision
- **Passwords:** new hashes use **Argon2id** (OWASP Password Storage Cheat Sheet parameters). Existing `pbkdf2_sha256$…` hashes verify unchanged and are **rehashed to Argon2id on successful login**. Minimum length 12 (parity); maximum 256 to bound hashing cost.
- **Sessions:** keep the opaque random token (32 bytes) with only its SHA-256 stored; 8 h absolute lifetime (parity). Expired sessions are purged by a scheduled job. Logout also clears the scope cookie.
- **Cookies:** `mascli_session` and `mascli_scope` keep `HttpOnly`, `SameSite=Strict`, `Path=/`, 8 h. `Secure` by default; `MASCLI_COOKIE_SECURE` accepts exactly `0` or `1`; any other value fails at startup (parity with P2b).
- **TOTP:** RFC 6238 SHA-1/6 digits/30 s/±1 window (interoperability parity). Secrets **encrypted at rest** with AES-256-GCM using `MASCLI_DATA_KEY`; the last accepted time step is stored to **reject replays**. Setup returns 409 when MFA is already enabled (parity with P2a).
- **Login throttling:** per-username and per-IP sliding window with exponential back-off, uniform 401 responses (no user enumeration), stored in Postgres (works across instances).
- **CSRF:** keep `SameSite=Strict` + Origin/Host check for every non-GET, now including `/login`, `/logout` and `/system/auth/scopes`.
- **Headers:** parity headers plus strict **CSP** (no inline script/handlers, see ADR 0006) and **HSTS** when Secure cookies are on.

## Amendment (T4 implementation and independent verification)
- **Throttling is a fixed 15-minute window, not exponential back-off:** 5 failures per username, 20 per client address. Each attempt is *reserved* atomically before the password is verified (per-subject `pg_advisory_xact_lock`, count, insert) and released on success. The first version counted, verified and then recorded, and an independent verifier bypassed it with 30 parallel requests. Rows outside the window are purged on every attempt.
- **Known trade-off:** anyone can lock a username for 15 minutes with 5 bad attempts. Accepted for an internal tool with few accounts; revisit with CAPTCHA or per-device trust if it is abused.
- **Client address:** the socket peer by default; with `MASCLI_TRUST_PROXY=1`, the right-most `X-Forwarded-For` entry (the one appended by the trusted proxy). Never trust the header without a proxy in front.
- **Session purge** runs on every successful login; a scheduled job is left to deployment readiness (T14).
- **CSP** belongs to the SPA and is delivered in T11; HSTS is sent whenever cookies are Secure.
- An unreadable sealed TOTP secret (corruption, wrong key) fails the second factor with 401 and logs an operator hint, never a 500.
- Timing: unknown users are verified against an eagerly computed Argon2id dummy hash. Accounts still holding a legacy PBKDF2 hash answer measurably slower until their next login rehashes them.

See [ADR 0009](0009-internet-exposure-hardening.md) for the stricter Origin rule, API CSP, host allowlist, mandatory MFA and MFA reset added before publishing the API.

## Consequences
- Users keep their passwords; hashes upgrade transparently.
- `MASCLI_DATA_KEY` becomes a required production secret; key rotation is a documented procedure.

## References
OWASP ASVS 4.0 (V2, V3), OWASP Password Storage and Session Management cheat sheets, RFC 6238, NIST SP 800-63B.
