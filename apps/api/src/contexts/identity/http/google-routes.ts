import { GoogleLinkRequest, type AuthProviders } from '@mascli/contracts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE, setAuthCookie } from '../../../platform/http/cookies.ts';
import type { AppEnv } from '../../../platform/http/env.ts';
import { parseJson } from '../../../platform/http/validation.ts';
import { type IdentityService, SESSION_SECONDS } from '../application/index.ts';
import type { GoogleAuthRequest, GoogleSignIn } from '../application/ports.ts';

/** Public paths of the Google flow; the session middleware lets them through (ADR 0010). */
export const GOOGLE_START_PATH = '/auth/google';
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback';

/**
 * Holds state, nonce and PKCE verifier between the redirect to Google and its return. Google
 * sends the browser back cross-site, so this cookie is SameSite=Lax (the session stays Strict).
 */
const FLOW_COOKIE = 'mascli_google_flow';
const FLOW_SECONDS = 600;
const RANDOM = /^[A-Za-z0-9_-]{43}$/;

const random = () => randomBytes(32).toString('base64url');

const sameSecret = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Where Google returns: the host the browser used, which the host allowlist already vetted. */
const redirectUri = (host: string | undefined, secure: boolean) =>
  host && /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)
    ? `${secure ? 'https' : 'http'}://${host}${GOOGLE_CALLBACK_PATH}`
    : null;

const LINK_ERRORS = {
  forbidden: [403, 'Administración de cuentas restringida'],
  invalid: [422, 'Usuario inválido'],
  invalid_email: [422, 'Correo de Google inválido'],
  missing: [404, 'Usuario inexistente'],
  taken: [409, 'Ese correo de Google ya está vinculado a otra cuenta'],
} as const;

export const googleRoutes = (deps: {
  identity: IdentityService;
  google: GoogleSignIn | undefined;
  cookieSecure: boolean;
}) => {
  const { identity, google, cookieSecure } = deps;
  const failed = (reason: string) => `/login?google=${reason}`;

  return new Hono<AppEnv>()
    .get('/system/auth/providers', (c) =>
      c.json({ google: google !== undefined } satisfies AuthProviders),
    )

    .get(GOOGLE_START_PATH, (c) => {
      if (!google) return c.json({ detail: 'Not Found' }, 404);
      const uri = redirectUri(c.req.header('host'), cookieSecure);
      if (!uri) return c.json({ detail: 'Host no permitido' }, 400);
      const flow = { state: random(), nonce: random(), codeVerifier: random() };
      setCookie(c, FLOW_COOKIE, `${flow.state}.${flow.nonce}.${flow.codeVerifier}`, {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'Lax',
        path: GOOGLE_START_PATH,
        maxAge: FLOW_SECONDS,
      });
      return c.redirect(google.authorizationUrl({ ...flow, redirectUri: uri }), 302);
    })

    .get(GOOGLE_CALLBACK_PATH, async (c) => {
      if (!google) return c.json({ detail: 'Not Found' }, 404);
      const stored = getCookie(c, FLOW_COOKIE) ?? '';
      deleteCookie(c, FLOW_COOKIE, {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'Lax',
        path: GOOGLE_START_PATH,
      });
      const [state = '', nonce = '', codeVerifier = ''] = stored.split('.');
      const uri = redirectUri(c.req.header('host'), cookieSecure);
      const returned = c.req.query('state') ?? '';
      if (![state, nonce, codeVerifier].every((part) => RANDOM.test(part)) || !uri) {
        return c.redirect(failed('expired'), 302);
      }
      if (!sameSecret(state, returned)) return c.redirect(failed('expired'), 302);
      const code = c.req.query('code');
      if (c.req.query('error') || !code) return c.redirect(failed('cancelled'), 302);

      const request: GoogleAuthRequest = { state, nonce, codeVerifier, redirectUri: uri };
      const profile = await google.exchange(code, request, new Date());
      if (!profile) return c.redirect(failed('failed'), 302);
      const result = await identity.loginWithGoogle(profile.email);
      if (!result.ok) return c.redirect(failed('not_linked'), 302);
      setAuthCookie(c, SESSION_COOKIE, result.value.token, cookieSecure, SESSION_SECONDS);
      return c.redirect('/', 302);
    })

    .post('/system/auth/accounts/:username/google', async (c) => {
      const body = await parseJson(c, GoogleLinkRequest);
      if (!body.ok) return body.response;
      const result = await identity.linkGoogle(
        c.get('identity'),
        c.req.param('username'),
        body.value.email,
      );
      if (!result.ok) {
        const [status, detail] = LINK_ERRORS[result.error];
        return c.json({ detail }, status);
      }
      return c.json({
        ok: true,
        username: c.req.param('username').trim().toLowerCase(),
        google_email: result.value,
      });
    });
};
