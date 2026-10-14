import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GoogleAuthRequest, GoogleSignIn } from '../application/ports.ts';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Tolerated clock difference with Google when checking `exp` and `iat`. */
const SKEW_SECONDS = 60;

export type GoogleClientConfig = { readonly clientId: string; readonly clientSecret: string };

const TokenResponse = z.object({ id_token: z.string() });
const IdTokenClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  name: z.string().optional(),
});

const base64Url = (bytes: Buffer) => bytes.toString('base64url');

/** RFC 7636 S256 code challenge. */
export const codeChallenge = (verifier: string) =>
  base64Url(createHash('sha256').update(verifier).digest());

const decodeClaims = (idToken: string) => {
  const [, payload, signature, ...rest] = idToken.split('.');
  if (!payload || signature === undefined || rest.length > 0) return null;
  try {
    const parsed = IdTokenClaims.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Google OpenID Connect client (authorization code + PKCE). The ID token comes straight from
 * Google's token endpoint over TLS, so per OpenID Connect Core 3.1.3.7 step 6 the TLS server
 * check stands in for the signature; every other claim is still validated (ADR 0010).
 */
export const createGoogleSignIn = (
  config: GoogleClientConfig,
  fetcher: typeof fetch = fetch,
): GoogleSignIn => ({
  authorizationUrl(request: GoogleAuthRequest) {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: request.state,
      nonce: request.nonce,
      code_challenge: codeChallenge(request.codeVerifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${AUTHORIZATION_ENDPOINT}?${params}`;
  },

  async exchange(code, request, at) {
    let response: Response;
    try {
      response = await fetcher(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: request.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: request.codeVerifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.error('Google token request failed', error);
      return null;
    }
    if (!response.ok) {
      console.error(`Google token endpoint answered ${response.status}`);
      return null;
    }
    const token = TokenResponse.safeParse(await response.json().catch(() => null));
    const claims = token.success ? decodeClaims(token.data.id_token) : null;
    if (!claims) return null;

    const now = Math.floor(at.getTime() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const valid =
      ISSUERS.has(claims.iss) &&
      audiences.length === 1 &&
      audiences[0] === config.clientId &&
      claims.exp > now - SKEW_SECONDS &&
      claims.iat < now + SKEW_SECONDS &&
      claims.nonce === request.nonce &&
      (claims.email_verified === true || claims.email_verified === 'true') &&
      typeof claims.email === 'string';
    if (!valid || claims.email === undefined) return null;
    return { email: claims.email, name: claims.name ?? claims.email };
  },
});
