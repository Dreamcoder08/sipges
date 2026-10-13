import type { MiddlewareHandler } from 'hono';

/**
 * The API serves JSON plus the server-rendered /select-project form (inline style attributes,
 * no scripts), so nothing else may load. The SPA brings its own policy (ADR 0006, T11).
 */
export const API_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Headers from app.py enforce_auth (behavior contract §2, step 10). Python skips them on
 * middleware-exempt routes such as /health; here they are applied to every response.
 * HSTS is added when cookies are Secure, i.e. the deployment is HTTPS (ADR 0004).
 */
export const securityHeaders =
  (options: { hsts: boolean }): MiddlewareHandler =>
  async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', API_CSP);
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (options.hsts) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };
