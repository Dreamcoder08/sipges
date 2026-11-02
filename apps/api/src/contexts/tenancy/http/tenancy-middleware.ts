import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { SCOPE_COOKIE } from '../../../platform/http/cookies.ts';
import type { AppEnv } from '../../../platform/http/env.ts';
import type { TenancyService } from '../application/index.ts';

/**
 * Global directory operations and personal MFA enrollment: authenticated and role-checked, but
 * not business-scope writes. Enrollment must work before any project is granted (ADR 0009).
 */
const SCOPE_FREE_PATHS = new Set([
  '/system/auth/scopes',
  '/system/auth/grants',
  '/system/auth/totp/setup',
  '/system/auth/totp/enable',
]);

const BODY_CHECKED_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** First truthy of body.project_id, body.payload.Proyecto_ID, body.payload.project_id (app.py:231-235). */
const projectFromBody = (body: unknown): unknown => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const payload =
    typeof record.payload === 'object' && record.payload !== null
      ? (record.payload as Record<string, unknown>)
      : {};
  return record.project_id || payload.Proyecto_ID || payload.project_id;
};

/**
 * app.py enforce_auth steps 4-7: resolve the authorized scope, then refuse requests whose
 * query or JSON body names another project. Runs after the session middleware.
 * (Step 5, "tenant database missing -> 503", has no equivalent: tenants are rows.)
 */
export const tenancyMiddleware =
  (tenancy: TenancyService): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const identity = c.get('identity');
    const accountDeactivation = /^\/system\/auth\/accounts\/[^/]+\/(deactivate|google)$/.test(
      c.req.path,
    );
    if (!identity || SCOPE_FREE_PATHS.has(c.req.path) || accountDeactivation) return next();

    const resolution = await tenancy.resolve({
      username: identity.username,
      header: c.req.header('x-sipges-scope'),
      cookie: getCookie(c, SCOPE_COOKIE),
    });
    if (!resolution.ok) {
      return c.json(
        {
          detail: 'Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project',
          projects: resolution.projects,
        },
        403,
      );
    }
    const { scope } = resolution;

    const requested = c.req.query('project_id');
    if (requested && requested !== scope.projectId) {
      return c.json({ detail: 'Proyecto fuera de alcance' }, 403);
    }

    const { method, path } = c.req;
    const jsonBody = (c.req.header('content-type') ?? '').startsWith('application/json');
    if (
      BODY_CHECKED_METHODS.has(method) &&
      jsonBody &&
      (path.startsWith('/api/') || path.startsWith('/system/'))
    ) {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const supplied = projectFromBody(body);
      if (supplied && supplied !== scope.projectId) {
        return c.json({ detail: 'No se permite escribir en otro proyecto' }, 403);
      }
    }

    c.set('scope', scope);
    return next();
  };
