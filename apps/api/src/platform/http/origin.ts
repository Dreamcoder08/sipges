import type { Context } from 'hono';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isWriteMethod = (method: string) => !READ_METHODS.has(method);

/**
 * app.py compares urlsplit(Origin).netloc with the Host header for state-changing requests.
 * Requests without an Origin header are accepted (same-site navigation, SameSite=Strict cookies).
 */
export const originAllowed = (c: Context): boolean => {
  const origin = c.req.header('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === c.req.header('host');
  } catch {
    return false;
  }
};

export const forbiddenOrigin = (c: Context) =>
  c.json({ detail: 'Origen de solicitud no permitido' }, 403);
