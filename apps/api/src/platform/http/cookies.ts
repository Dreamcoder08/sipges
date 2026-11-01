import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'sipges_session';
export const SCOPE_COOKIE = 'sipges_scope';

/** HttpOnly, SameSite=Strict, Path=/, 8 h; Secure per SIPGES_COOKIE_SECURE (ADR 0004). */
export const setAuthCookie = (
  c: Context,
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
) => setCookie(c, name, value, { httpOnly: true, sameSite: 'Strict', secure, maxAge, path: '/' });

export const clearAuthCookie = (c: Context, name: string, secure: boolean) =>
  deleteCookie(c, name, { httpOnly: true, sameSite: 'Strict', secure, path: '/' });
