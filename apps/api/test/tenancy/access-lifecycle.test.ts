import { AccountSummary } from '@mascli/contracts';
import { describe, expect, it, vi } from 'vitest';
import { passwordHasher } from '../../src/contexts/identity/infrastructure/password-hasher.ts';
import { createTestApp } from '../support/test-app.ts';

const USER = {
  username: 'viewer',
  full_name: 'Viewer',
  password: 'viewer-password-123',
  role: 'analista',
};
const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  expect((await t.createAccount(admin.cookie, USER)).status).toBe(200);
  await t.grant(admin.cookie, USER.username);
  const user = await t.login(USER.username, USER.password);
  return { t, admin, user };
};
const revoke = (
  t: Awaited<ReturnType<typeof createTestApp>>,
  cookie: string,
  username = USER.username,
) =>
  t.request('/system/auth/grants', {
    method: 'DELETE',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username, company_id: 'MASCLI', project_id: 'PRJ-SECHURA' }),
  });
const deactivate = (
  t: Awaited<ReturnType<typeof createTestApp>>,
  cookie: string,
  username = USER.username,
  origin?: string,
) =>
  t.request(`/system/auth/accounts/${username}/deactivate`, {
    method: 'POST',
    headers: { cookie, ...(origin ? { origin } : {}) },
  });
const scopes = async (t: Awaited<ReturnType<typeof createTestApp>>, cookie: string) =>
  (await t.request('/system/auth/scopes', { headers: { cookie } })).json();

describe('administrator access lifecycle', () => {
  it('revokes a grant immediately without destroying the user session', async () => {
    const { t, admin, user } = await setup();
    const res = await revoke(t, admin.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await scopes(t, user.cookie)).toEqual([]);
    const denied = await t.request('/system/auth/current-scope', {
      headers: { cookie: user.cookie },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      detail: 'Seleccione un proyecto autorizado mediante X-MASCLI-Scope o /select-project',
      projects: [],
    });
    const me = await t.request('/system/auth/me', { headers: { cookie: user.cookie } });
    expect(await me.json()).toMatchObject({ username: USER.username });
    await t.grant(admin.cookie, USER.username);
    expect(
      (await t.request('/system/auth/current-scope', { headers: { cookie: user.cookie } })).status,
    ).toBe(200);
  });

  it('rejects non-admin grant revocation and leaves the grant unchanged', async () => {
    const { t, user } = await setup();
    const before = await scopes(t, user.cookie);
    const res = await revoke(t, user.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: 'Forbidden' });
    expect(await scopes(t, user.cookie)).toEqual(before);
  });

  it('reports missing grant references without removing existing access', async () => {
    const { t, admin, user } = await setup();
    const before = await scopes(t, user.cookie);
    const missingUser = await revoke(t, admin.cookie, 'absent');
    expect(missingUser.status).toBe(404);
    expect(await missingUser.json()).toEqual({ detail: 'Usuario inexistente' });
    expect(await scopes(t, user.cookie)).toEqual(before);
    expect((await revoke(t, admin.cookie)).status).toBe(200);
    const missingGrant = await revoke(t, admin.cookie);
    expect(missingGrant.status).toBe(404);
    expect(await missingGrant.json()).toEqual({ detail: 'Acceso inexistente' });
    expect(await scopes(t, user.cookie)).toEqual([]);
  });

  it('deactivates an account, revokes every session and rejects future logins', async () => {
    const { t, admin, user } = await setup();
    const second = await t.login(USER.username, USER.password);
    const res = await deactivate(t, admin.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    for (const cookie of [user.cookie, second.cookie]) {
      const me = await t.request('/system/auth/me', { headers: { cookie } });
      expect(me.status).toBe(200);
      expect(await me.json()).toBeNull();
      expect((await t.request('/system/auth/scopes', { headers: { cookie } })).status).toBe(401);
    }
    const login = await t.login(USER.username, USER.password);
    expect(login.res.status).toBe(401);
    expect(await login.res.json()).toEqual({ detail: 'Credenciales inválidas' });
    expect(login.res.headers.get('set-cookie')).toBeNull();
    const accounts = await t.request('/system/auth/accounts', {
      headers: { cookie: admin.cookie },
    });
    expect(
      AccountSummary.array()
        .parse(await accounts.json())
        .find((a) => a.username === USER.username)?.active,
    ).toBe(0);
    expect((await deactivate(t, admin.cookie)).status).toBe(200);
  });

  it('rejects non-admin deactivation and cross-origin writes without changing access', async () => {
    const { t, admin, user } = await setup();
    const denied = await deactivate(t, user.cookie);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ detail: 'Administración de cuentas restringida' });
    const crossOrigin = await deactivate(t, admin.cookie, USER.username, 'https://evil.example');
    expect(crossOrigin.status).toBe(403);
    expect((await t.login(USER.username, USER.password)).res.status).toBe(200);
    expect(
      (await t.request('/system/auth/current-scope', { headers: { cookie: user.cookie } })).status,
    ).toBe(200);
  });

  it('reports a missing account and preserves current sessions', async () => {
    const { t, admin, user } = await setup();
    const res = await deactivate(t, admin.cookie, 'absent');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Usuario inexistente' });
    expect((await t.request('/system/auth/me', { headers: { cookie: user.cookie } })).status).toBe(
      200,
    );
    expect((await t.login(USER.username, USER.password)).res.status).toBe(200);
  });

  it('prevents removal of the last active administrator', async () => {
    const { t, admin } = await setup();
    const res = await deactivate(t, admin.cookie, 'admin');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      detail: 'No se permite desactivar el último administrador',
    });
    const me = await t.request('/system/auth/me', { headers: { cookie: admin.cookie } });
    expect(await me.json()).toMatchObject({ username: 'admin' });
    expect((await t.login('admin', 'admin-password-123')).res.status).toBe(200);
  });

  it('does not issue a session when deactivation wins an in-flight login', async () => {
    const { t, admin } = await setup();
    const original = passwordHasher.verify;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(passwordHasher, 'verify').mockImplementation(async (password, hash) => {
      const valid = await original(password, hash);
      if (password === USER.password) {
        entered();
        await hold;
      }
      return valid;
    });
    const pending = t.login(USER.username, USER.password);
    try {
      await waiting;
      const res = await deactivate(t, admin.cookie);
      expect(res.status).toBe(200);
      release();
      const login = await pending;
      expect(login.res.status).toBe(401);
      expect(await login.res.json()).toEqual({ detail: 'Credenciales inválidas' });
      expect(login.res.headers.get('set-cookie')).toBeNull();
    } finally {
      release();
      await pending;
      spy.mockRestore();
    }
  });
});
