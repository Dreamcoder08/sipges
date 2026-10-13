import {
  AccountCreate,
  type AccountSummary,
  LoginForm,
  type LoginResponse,
  type Me,
  TotpEnableRequest,
} from '@mascli/contracts';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  SCOPE_COOKIE,
  SESSION_COOKIE,
  clearAuthCookie,
  setAuthCookie,
} from '../../../platform/http/cookies.ts';
import type { AppEnv, ClientIp } from '../../../platform/http/env.ts';
import { parseForm, parseJson } from '../../../platform/http/validation.ts';
import { isoSeconds } from '../../../platform/http/time.ts';
import { type IdentityService, type LoginError, SESSION_SECONDS } from '../application/index.ts';

const LOGIN_ERRORS: Record<LoginError['kind'], string> = {
  invalid_credentials: 'Credenciales inválidas',
  invalid_otp: 'Código de autenticación inválido',
  throttled: 'Demasiados intentos fallidos; intente más tarde',
};

const TOTP_INSTRUCTION =
  'Añada el código en una aplicación TOTP y confirme con /system/auth/totp/enable.';

/** ISO-8601 UTC with second precision, e.g. 2026-10-12T12:00:00Z (ADR 0008 #14). */

export const authRoutes = (deps: {
  identity: IdentityService;
  cookieSecure: boolean;
  clientIp: ClientIp;
}) => {
  const { identity, cookieSecure, clientIp } = deps;

  return new Hono<AppEnv>()
    .post('/login', async (c) => {
      const form = await parseForm(c, LoginForm);
      if (!form.ok) return form.response;
      const result = await identity.login({ ...form.value, ip: clientIp(c) });
      if (!result.ok) {
        const { error } = result;
        if (error.kind === 'throttled') c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({ detail: LOGIN_ERRORS[error.kind] }, error.kind === 'throttled' ? 429 : 401);
      }
      setAuthCookie(c, SESSION_COOKIE, result.value.token, cookieSecure, SESSION_SECONDS);
      const { fullName, role } = result.value.identity;
      return c.json({ ok: true, name: fullName, role } satisfies LoginResponse);
    })

    .post('/logout', async (c) => {
      await identity.logout(getCookie(c, SESSION_COOKIE));
      clearAuthCookie(c, SESSION_COOKIE, cookieSecure);
      clearAuthCookie(c, SCOPE_COOKIE, cookieSecure);
      return c.json({ ok: true });
    })

    .get('/system/auth/me', async (c) => {
      const principal = await identity.authenticate(getCookie(c, SESSION_COOKIE));
      const body: Me = principal
        ? {
            username: principal.username,
            full_name: principal.fullName,
            role: principal.role,
            active: 1,
          }
        : null;
      return c.json(body);
    })

    .get('/system/auth/accounts', async (c) => {
      const accounts = await identity.listAccounts();
      return c.json(
        accounts.map((a): AccountSummary => ({
          username: a.username,
          full_name: a.fullName,
          role: a.role,
          active: a.active ? 1 : 0,
          created_at: isoSeconds(a.createdAt),
        })),
      );
    })

    .post('/system/auth/accounts', async (c) => {
      const body = await parseJson(c, AccountCreate);
      if (!body.ok) return body.response;
      const { username, full_name: fullName, password, role } = body.value;
      const result = await identity.createAccount({ username, fullName, password, role });
      if (!result.ok) {
        return result.error.kind === 'exists'
          ? c.json({ detail: 'Usuario existente' }, 409)
          : c.json({ detail: result.error.detail }, 422);
      }
      return c.json({ ok: true, username: result.value.username, role: result.value.role });
    })

    .post('/system/auth/accounts/:username/deactivate', async (c) => {
      const result = await identity.deactivateAccount(c.get('identity'), c.req.param('username'));
      if (!result.ok) {
        const errors = {
          forbidden: [403, 'Administración de cuentas restringida'],
          invalid: [422, 'Usuario inválido'],
          missing: [404, 'Usuario inexistente'],
          last_admin: [409, 'No se permite desactivar el último administrador'],
        } as const;
        const [status, detail] = errors[result.error];
        return c.json({ detail }, status);
      }
      if (c.req.param('username').trim().toLowerCase() === c.get('identity').username) {
        clearAuthCookie(c, SESSION_COOKIE, cookieSecure);
        clearAuthCookie(c, SCOPE_COOKIE, cookieSecure);
      }
      return c.json({ ok: true });
    })

    .post('/system/auth/totp/setup', async (c) => {
      const result = await identity.setupTotp(c.get('identity').username);
      if (!result.ok) {
        return c.json(
          { detail: 'MFA ya está activado; no se permite reiniciar la configuración' },
          409,
        );
      }
      return c.json({
        secret: result.value.secret,
        otpauth_uri: result.value.uri,
        instruction: TOTP_INSTRUCTION,
      });
    })

    .post('/system/auth/totp/enable', async (c) => {
      const body = await parseJson(c, TotpEnableRequest);
      if (!body.ok) return body.response;
      const result = await identity.enableTotp(
        c.get('identity').username,
        body.value.code,
        c.get('sessionToken'),
      );
      if (!result.ok) return c.json({ detail: 'Código TOTP incorrecto' }, 422);
      return c.json({ ok: true, totp_enabled: true });
    });
};
