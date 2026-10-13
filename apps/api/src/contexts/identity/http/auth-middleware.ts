import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../../../platform/http/cookies.ts';
import type { AppEnv } from '../../../platform/http/env.ts';
import { forbiddenOrigin, isWriteMethod, originAllowed } from '../../../platform/http/origin.ts';
import type { IdentityService } from '../application/index.ts';

/** Routes reachable without a session (app.py enforce_auth exemptions). */
const PUBLIC_PATHS = new Set([
  '/health',
  '/login',
  '/logout',
  '/select-project',
  '/system/auth/me',
]);

/**
 * Steps 1-3 and 8 of app.py enforce_auth (behavior contract §2): public routes, session,
 * Origin check and role gates. Tenancy steps 4-7 plug in after this middleware (T5).
 * Unlike Python, public routes also get the Origin check (ADR 0008 #4).
 */
export const authMiddleware =
  (identity: IdentityService): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const { path, method } = c.req;
    const write = isWriteMethod(method);

    if (PUBLIC_PATHS.has(path)) {
      if (write && !originAllowed(c)) return forbiddenOrigin(c);
      return next();
    }

    const token = getCookie(c, SESSION_COOKIE);
    const principal = await identity.authenticate(token);
    if (!principal || !token) {
      return c.json({ detail: 'Inicie sesión para acceder a MASCLI' }, 401);
    }
    if (write && !originAllowed(c)) return forbiddenOrigin(c);

    const decision = identity.checkAccess(principal.role, method, path);
    if (!decision.allowed) return c.json({ detail: decision.detail }, 403);

    c.set('identity', principal);
    c.set('sessionToken', token);
    return next();
  };
