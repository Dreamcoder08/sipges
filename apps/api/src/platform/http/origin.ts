import type { Context } from 'hono';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const isWriteMethod = (method: string) => !READ_METHODS.has(method);

const hostOf = (url: string | undefined): string | undefined => {
  if (!url || url === 'null') return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

/**
 * app.py compared urlsplit(Origin).netloc with Host only when Origin was present. State-changing
 * requests must now prove they come from this host (ADR 0009): Origin, or Referer when a
 * browser omits Origin. A request with neither is refused, so a missing header cannot bypass
 * the check. Non-browser clients send `Origin: https://<host>`.
 */
export const originAllowed = (c: Context): boolean => {
  const host = c.req.header('host');
  if (!host) return false;
  const source = hostOf(c.req.header('origin')) ?? hostOf(c.req.header('referer'));
  return source !== undefined && source.toLowerCase() === host.toLowerCase();
};

export const forbiddenOrigin = (c: Context) =>
  c.json({ detail: 'Origen de solicitud no permitido' }, 403);
