# 0010 — Sign in with Google

## Context
The academic demo is used by its owner and a few invited people. Each of them had to keep a password and enroll a TOTP authenticator (ADR 0009) before seeing anything. The owner asked for them to sign in with their Google accounts instead. The demo must stay invitation-only: a Google account is not, by itself, a reason to see project data.

## Decision
1. **OpenID Connect, authorization code with PKCE.** `GET /auth/google` stores a random `state`, `nonce` and PKCE verifier in an HttpOnly cookie (`SameSite=Lax`, path `/auth/google`, 10 minutes) and redirects to Google. `GET /auth/google/callback` requires the returned `state` to match that cookie, clears it, and exchanges the code with the client secret and the verifier. No new dependency: the adapter uses `fetch`.
2. **ID token validation.** The token comes straight from Google's token endpoint over TLS, so the TLS server check replaces the signature check (OpenID Connect Core 3.1.3.7, step 6). The issuer, the single audience (our client ID), `exp` and `iat` (60 s skew), the `nonce` and `email_verified` are still checked.
3. **Invitation only.** An administrator links one Google address to one existing account (`POST /system/auth/accounts/:username/google`, admin only, scope-free; an empty address unlinks). Unknown or deactivated addresses get `/login?google=not_linked`; nobody is created on first sign-in. Roles and project grants stay as they are.
4. **Google counts as the second factor.** Sessions opened by Google are marked `via_google`, and the MFA gate of ADR 0009 treats them as enrolled. Password sign-in is unchanged and still needs TOTP. Changing or removing an account's address ends its Google sessions.
5. **Bootstrap.** `SIPGES_GOOGLE_ADMIN_EMAIL` links the bootstrap administrator on start when that account has no address yet, so a fresh installation can be reached with Google alone. It never replaces an address an administrator set.
6. **Configuration.** `SIPGES_GOOGLE_CLIENT_ID` and `SIPGES_GOOGLE_CLIENT_SECRET` (both or neither). Without them, `GET /system/auth/providers` answers `{ "google": false }`, the button is hidden and the `/auth/google*` routes answer 404. The redirect URI is `https://<host the browser used>/auth/google/callback`; that host has already passed the host allowlist, and Google only accepts URIs registered in the client.

## Consequences
- The security of a Google-linked account is the security of that Google account. Linked users should turn on Google 2-Step Verification; an administrator's Google account deserves the same care as their password and authenticator.
- The session cookie stays `SameSite=Strict`. Only the short-lived flow cookie is `Lax`, because Google sends the browser back cross-site.
- Every public host used to sign in must have its callback URI registered in the Google OAuth client.
- Tests: `apps/api/test/identity/google-sign-in.test.ts`, `google-oidc.test.ts`.

## References
OpenID Connect Core 1.0 §3.1 and §3.1.3.7; RFC 7636 (PKCE); RFC 9700 (OAuth 2.0 Security BCP) §2.1 and §4.7; Google Identity, "OpenID Connect".
