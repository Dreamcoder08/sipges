import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  codeChallenge,
  createGoogleSignIn,
} from '../../src/contexts/identity/infrastructure/google-oidc.ts';

const CONFIG = { clientId: 'client.apps.example', clientSecret: 'synthetic-secret' };
const AT = new Date('2026-10-14T12:00:00Z');
const NOW = Math.floor(AT.getTime() / 1000);
const REQUEST = {
  redirectUri: 'https://mascli.example/auth/google/callback',
  state: 's'.repeat(43),
  nonce: 'n'.repeat(43),
  codeVerifier: 'v'.repeat(43),
};
const CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: CONFIG.clientId,
  exp: NOW + 3600,
  iat: NOW - 5,
  nonce: REQUEST.nonce,
  email: 'persona.sintetica@example.com',
  email_verified: true,
  name: 'Persona Sintética',
};

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const idToken = (claims: object) => `${segment({ alg: 'RS256' })}.${segment(claims)}.c2lnbmF0dXJl`;

/** Fake token endpoint; `calls` keeps what MASCLI sent to it. */
const tokenEndpoint = (answer: () => Response | Promise<Response>) => {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
    return answer();
  }) as typeof fetch;
  return { calls, fetcher };
};

const withClaims = (claims: object) =>
  tokenEndpoint(() => Response.json({ id_token: idToken(claims), access_token: 'x' }));

describe('Google OpenID Connect client', () => {
  it('builds an authorization request with PKCE S256, nonce and state', () => {
    const url = new URL(createGoogleSignIn(CONFIG).authorizationUrl(REQUEST));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: CONFIG.clientId,
      redirect_uri: REQUEST.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: REQUEST.state,
      nonce: REQUEST.nonce,
      code_challenge_method: 'S256',
    });
    expect(params.code_challenge).toBe(
      createHash('sha256').update(REQUEST.codeVerifier).digest('base64url'),
    );
    expect(codeChallenge(REQUEST.codeVerifier)).toBe(params.code_challenge);
    expect(JSON.stringify(params)).not.toContain(CONFIG.clientSecret);
  });

  it('exchanges the code and returns the verified address', async () => {
    const endpoint = withClaims(CLAIMS);
    const google = createGoogleSignIn(CONFIG, endpoint.fetcher);
    expect(await google.exchange('code-1', REQUEST, AT)).toEqual({
      email: CLAIMS.email,
      name: CLAIMS.name,
    });
    expect(endpoint.calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(endpoint.calls[0]?.body ?? [])).toEqual({
      code: 'code-1',
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
      redirect_uri: REQUEST.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: REQUEST.codeVerifier,
    });
  });

  it.each([
    ['another issuer', { iss: 'https://evil.example' }],
    ['another audience', { aud: 'other.apps.example' }],
    ['several audiences', { aud: [CONFIG.clientId, 'other.apps.example'] }],
    ['an expired token', { exp: NOW - 120 }],
    ['a token issued in the future', { iat: NOW + 600 }],
    ['another nonce', { nonce: 'x'.repeat(43) }],
    ['an unverified address', { email_verified: false }],
    ['no address', { email: undefined }],
  ])('refuses %s', async (_label, change) => {
    const google = createGoogleSignIn(CONFIG, withClaims({ ...CLAIMS, ...change }).fetcher);
    expect(await google.exchange('code', REQUEST, AT)).toBeNull();
  });

  it('refuses errors and malformed answers from the token endpoint', async () => {
    const answers = [
      () => new Response('{"error":"invalid_grant"}', { status: 400 }),
      () => Response.json({ access_token: 'only' }),
      () => Response.json({ id_token: 'not-a-jwt' }),
      () => Response.json({ id_token: 'a.bm90LWpzb24.c' }),
      () => new Response('not json'),
      () => Promise.reject(new Error('network down')),
    ];
    for (const answer of answers) {
      const google = createGoogleSignIn(CONFIG, tokenEndpoint(answer).fetcher);
      expect(await google.exchange('code', REQUEST, AT)).toBeNull();
    }
  });
});
