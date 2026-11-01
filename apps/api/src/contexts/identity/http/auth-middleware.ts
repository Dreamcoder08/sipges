import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../../../platform/http/cookies.ts';
import type { AppEnv } from '../../../platform/http/env.ts';
import { currentRequestContext } from '../../../platform/request-context.ts';
import { forbiddenOrigin, isWriteMethod, originAllowed } from '../../../platform/http/origin.ts';
import { type IdentityService, clearanceFor } from '../application/index.ts';
import { GOOGLE_CALLBACK_PATH, GOOGLE_START_PATH } from './google-routes.ts';

/** Routes reachable without a session (app.py enforce_auth exemptions, minus ADR 0008 #4). */
const PUBLIC_PATHS = new Set([
  '/health',
  '/login',
  '/logout',
  '/select-project',
  '/system/auth/me',
  '/system/auth/providers',
  GOOGLE_START_PATH,
  GOOGLE_CALLBACK_PATH,
]);

/**
 * Machine endpoints authenticate with a bearer credential of their own (cron secret, API key)
 * and never with the session cookie, so neither the session nor the Origin check applies
 * (ADR 0014 §4, §6). Their routes refuse any request without that credential.
 */
const isMachinePath = (path: string) =>
  path === '/system/automations/cron' || path === '/mcp' || path.startsWith('/hooks/');

/** The only routes a session without an enrolled second factor may use (ADR 0009). */
export const MFA_ENROLLMENT_PATHS = new Set([
  '/system/auth/totp/setup',
  '/system/auth/totp/enable',
]);

export const MFA_REQUIRED_DETAIL =
  'Active la verificación en dos pasos (MFA) con /system/auth/totp/setup antes de continuar';

/**
 * app.py enforce_auth steps 1-3: public routes, session, Origin check.
 * Unlike Python, public routes also get the Origin check (ADR 0008 #4), and with
 * `requireMfa` a session must enroll TOTP before reaching anything else (ADR 0009).
 */
export const sessionMiddleware =
  (identity: IdentityService, options: { requireMfa: boolean }): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const write = isWriteMethod(c.req.method);
    if (isMachinePath(c.req.path)) return next();

    if (PUBLIC_PATHS.has(c.req.path)) {
      if (write && !originAllowed(c)) return forbiddenOrigin(c);
      return next();
    }

    const token = getCookie(c, SESSION_COOKIE);
    const principal = await identity.authenticate(token);
    if (!principal || !token) {
      return c.json({ detail: 'Inicie sesión para acceder a SIPGES' }, 401);
    }
    if (write && !originAllowed(c)) return forbiddenOrigin(c);
    if (options.requireMfa && !principal.mfaEnabled && !MFA_ENROLLMENT_PATHS.has(c.req.path)) {
      return c.json({ detail: MFA_REQUIRED_DETAIL, mfa_required: true }, 403);
    }

    c.set('identity', principal);
    c.set('sessionToken', token);
    const context = currentRequestContext();
    if (context) {
      context.actor = principal.username;
      context.clearance = clearanceFor(principal.role);
    }
    return next();
  };

/** app.py enforce_auth step 8: role gates, evaluated after tenancy resolved the scope. */
export const roleGate =
  (identity: IdentityService): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const principal = c.get('identity');
    if (!principal) return next();
    const decision = identity.checkAccess(principal.role, c.req.method, c.req.path);
    if (!decision.allowed) return c.json({ detail: decision.detail }, 403);
    return next();
  };
