import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../../../platform/http/cookies.ts';
import type { AppEnv } from '../../../platform/http/env.ts';
import { forbiddenOrigin, isWriteMethod, originAllowed } from '../../../platform/http/origin.ts';
import type { IdentityService } from '../application/index.ts';

/** Routes reachable without a session (app.py enforce_auth exemptions, minus ADR 0008 #4). */
const PUBLIC_PATHS = new Set([
  '/health',
  '/login',
  '/logout',
  '/select-project',
  '/system/auth/me',
]);

/**
 * app.py enforce_auth steps 1-3: public routes, session, Origin check.
 * Unlike Python, public routes also get the Origin check (ADR 0008 #4).
 */
export const sessionMiddleware =
  (identity: IdentityService): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const write = isWriteMethod(c.req.method);

    if (PUBLIC_PATHS.has(c.req.path)) {
      if (write && !originAllowed(c)) return forbiddenOrigin(c);
      return next();
    }

    const token = getCookie(c, SESSION_COOKIE);
    const principal = await identity.authenticate(token);
    if (!principal || !token) {
      return c.json({ detail: 'Inicie sesión para acceder a MASCLI' }, 401);
    }
    if (write && !originAllowed(c)) return forbiddenOrigin(c);

    c.set('identity', principal);
    c.set('sessionToken', token);
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
