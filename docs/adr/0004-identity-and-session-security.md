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

## Consequences
- Users keep their passwords; hashes upgrade transparently.
- `MASCLI_DATA_KEY` becomes a required production secret; key rotation is a documented procedure.

## References
OWASP ASVS 4.0 (V2, V3), OWASP Password Storage and Session Management cheat sheets, RFC 6238, NIST SP 800-63B.
