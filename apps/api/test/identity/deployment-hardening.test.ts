import { describe, expect, it } from 'vitest';
import { runAdminCommand } from '../../src/admin-cli.ts';
import { createSqlIdentityStore } from '../../src/contexts/identity/infrastructure/sql-identity-store.ts';
import { totp } from '../../src/contexts/identity/infrastructure/totp.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { API_CSP } from '../../src/platform/http/security-headers.ts';
import { ORIGIN, TEST_ENV, createTestApp } from '../support/test-app.ts';

// ADR 0009: controls required before publishing the API on the internet.

const ADMIN = { username: 'admin', password: 'admin-password-123' };
const ANALYST = {
  username: 'ana.perez',
  full_name: 'Ana Pérez',
  password: 'analyst-pass-123',
  role: 'analista',
};
const MFA_ON = { SIPGES_REQUIRE_MFA: '1' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const enroll = async (t: TestApp, cookie: string) => {
  const setup = await t.request('/system/auth/totp/setup', { method: 'POST', headers: { cookie } });
  expect(setup.status).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  const enable = await t.request('/system/auth/totp/enable', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ code: totp.codeAt(secret, t.clock.now()) }),
  });
  expect(enable.status).toBe(200);
  return secret;
};

/** Admin with MFA enrolled; the clock moves past the enrollment step so codes are not replays. */
const enrolledAdmin = async (t: TestApp) => {
  const first = await t.login(ADMIN.username, ADMIN.password);
  const secret = await enroll(t, first.cookie);
  t.clock.advance(30);
  return { cookie: first.cookie, secret };
};

describe('configuration', () => {
  const base = { SIPGES_DATA_KEY: TEST_ENV.SIPGES_DATA_KEY };

  it('requires MFA unless SIPGES_REQUIRE_MFA is exactly "0"', () => {
    expect(loadConfig(base).requireMfa).toBe(true);
    expect(loadConfig({ ...base, SIPGES_REQUIRE_MFA: '0' }).requireMfa).toBe(false);
    expect(() => loadConfig({ ...base, SIPGES_REQUIRE_MFA: 'no' })).toThrow(
      "SIPGES_REQUIRE_MFA must be unset or exactly '0' or '1'",
    );
  });

  it('parses the host allowlist and rejects malformed names', () => {
    expect(loadConfig(base).allowedHosts).toEqual([]);
    expect(
      loadConfig({ ...base, SIPGES_ALLOWED_HOSTS: ' Sipges.Example.org , localhost ' })
        .allowedHosts,
    ).toEqual(['sipges.example.org', 'localhost']);
    expect(() => loadConfig({ ...base, SIPGES_ALLOWED_HOSTS: 'evil.example:443' })).toThrow(
      'SIPGES_ALLOWED_HOSTS has an invalid host name',
    );
  });
});

describe('security headers', () => {
  it('sends a CSP that forbids scripts and framing on every response', async () => {
    const t = await createTestApp();
    for (const res of [await t.request('/health'), await t.request('/api/eventos')]) {
      expect(res.headers.get('content-security-policy')).toBe(API_CSP);
      expect(res.headers.get('permissions-policy')).toContain('camera=()');
    }
    expect(API_CSP).toContain("default-src 'none'");
    expect(API_CSP).not.toContain('script-src');
  });
});

describe('host allowlist', () => {
  it('rejects unexpected Host headers when configured', async () => {
    const t = await createTestApp({ SIPGES_ALLOWED_HOSTS: 'sipges.example.org' });
    const evil = await t.request('/health', { headers: { host: 'evil.example' } });
    expect(evil.status).toBe(400);
    expect(await evil.json()).toEqual({ detail: 'Host no permitido' });
    const good = await t.request('/health', { headers: { host: 'sipges.example.org:443' } });
    expect(good.status).toBe(200);
  });

  it('is disabled by default for local development', async () => {
    const t = await createTestApp();
    expect((await t.request('/health', { headers: { host: 'anything.local' } })).status).toBe(200);
  });
});

describe('strict origin check', () => {
  const loginForm = (t: TestApp) => t.form({ username: 'admin', password: ADMIN.password });

  it('refuses writes that carry neither Origin nor Referer', async () => {
    const t = await createTestApp();
    const res = await t.request('/login', {
      method: 'POST',
      headers: { origin: '' },
      body: loginForm(t),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: 'Origen de solicitud no permitido' });
  });

  it.each([['null'], ['not a url']])('refuses Origin %j', async (origin) => {
    const t = await createTestApp();
    const res = await t.request('/login', {
      method: 'POST',
      headers: { origin },
      body: loginForm(t),
    });
    expect(res.status).toBe(403);
  });

  it('accepts a same-host Referer when the browser omits Origin', async () => {
    const t = await createTestApp();
    const res = await t.request('/login', {
      method: 'POST',
      headers: { origin: '', referer: `${ORIGIN}/login` },
      body: loginForm(t),
    });
    expect(res.status).toBe(200);
  });

  it('refuses a foreign Referer', async () => {
    const t = await createTestApp();
    const res = await t.request('/login', {
      method: 'POST',
      headers: { origin: '', referer: 'https://evil.example/login' },
      body: loginForm(t),
    });
    expect(res.status).toBe(403);
  });
});

describe('mandatory MFA', () => {
  it('blocks every business route until the session enrolls TOTP', async () => {
    const t = await createTestApp(MFA_ON);
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    const blocked = await t.request('/api/eventos', { headers: { cookie } });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ mfa_required: true });

    await enroll(t, cookie);
    expect((await t.request('/api/eventos', { headers: { cookie } })).status).toBe(200);
  });

  it('lets read-only roles without any project grant enroll', async () => {
    const t = await createTestApp(MFA_ON);
    const admin = await enrolledAdmin(t);
    const adminCookie = (
      await t.login(ADMIN.username, ADMIN.password, totp.codeAt(admin.secret, t.clock.now()))
    ).cookie;
    const created = await t.createAccount(adminCookie, { ...ANALYST, role: 'consulta' });
    expect(created.status).toBe(200);

    const reader = await t.login(ANALYST.username, ANALYST.password);
    await enroll(t, reader.cookie);
  });

  it('keeps /system/auth/me available to drive the enrollment screen', async () => {
    const t = await createTestApp(MFA_ON);
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    expect((await t.request('/system/auth/me', { headers: { cookie } })).status).toBe(200);
  });

  it('is off when SIPGES_REQUIRE_MFA=0', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login(ADMIN.username, ADMIN.password);
    expect((await t.request('/api/eventos', { headers: { cookie } })).status).toBe(200);
  });
});

describe('POST /system/auth/accounts/:username/reset-mfa', () => {
  const reset = (t: TestApp, cookie: string, username: string) =>
    t.request(`/system/auth/accounts/${encodeURIComponent(username)}/reset-mfa`, {
      method: 'POST',
      headers: { cookie },
    });

  const setupWithEnrolledAnalyst = async () => {
    const t = await createTestApp(MFA_ON);
    const admin = await enrolledAdmin(t);
    const adminLogin = await t.login(
      ADMIN.username,
      ADMIN.password,
      totp.codeAt(admin.secret, t.clock.now()),
    );
    expect((await t.createAccount(adminLogin.cookie, ANALYST)).status).toBe(200);
    await t.grant(adminLogin.cookie, ANALYST.username);
    const analyst = await t.login(ANALYST.username, ANALYST.password);
    await enroll(t, analyst.cookie);
    return { t, adminCookie: adminLogin.cookie, analystCookie: analyst.cookie };
  };

  it('clears the factor, ends the sessions and forces a new enrollment', async () => {
    const { t, adminCookie, analystCookie } = await setupWithEnrolledAnalyst();
    expect((await t.request('/api/eventos', { headers: { cookie: analystCookie } })).status).toBe(
      200,
    );

    const res = await reset(t, adminCookie, 'ANA.PEREZ');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, username: 'ana.perez' });
    expect((await t.request('/api/eventos', { headers: { cookie: analystCookie } })).status).toBe(
      401,
    );

    const [row] = await t.sql.query<{ totp_enabled: boolean; totp_secret_sealed: string | null }>(
      "SELECT totp_enabled, totp_secret_sealed FROM users WHERE username = 'ana.perez'",
    );
    expect(row).toEqual({ totp_enabled: false, totp_secret_sealed: null });

    const again = await t.login(ANALYST.username, ANALYST.password);
    expect(again.res.status).toBe(200);
    const blocked = await t.request('/api/eventos', { headers: { cookie: again.cookie } });
    expect(await blocked.json()).toMatchObject({ mfa_required: true });
  });

  it('refuses to reset the administrator’s own MFA', async () => {
    const { t, adminCookie } = await setupWithEnrolledAnalyst();
    const res = await reset(t, adminCookie, 'admin');
    expect(res.status).toBe(403);
    const [row] = await t.sql.query<{ totp_enabled: boolean }>(
      "SELECT totp_enabled FROM users WHERE username = 'admin'",
    );
    expect(row?.totp_enabled).toBe(true);
    expect(await auditOf(t, adminCookie)).toEqual([]);
  });

  it('is restricted to administrators', async () => {
    const { t, adminCookie, analystCookie } = await setupWithEnrolledAnalyst();
    const res = await reset(t, analystCookie, 'admin');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: 'Administración de cuentas restringida' });
    expect(await auditOf(t, adminCookie)).toEqual([]);
  });

  const auditOf = async (t: TestApp, cookie: string) =>
    (
      (await (await t.request('/system/audit', { headers: { cookie } })).json()) as {
        module: string;
        record_id: string | null;
        action: string;
        detail: string | null;
      }[]
    ).filter((entry) => entry.action === 'MFA_RESET');

  it('writes an audit row in the active project naming the administrator', async () => {
    const { t, adminCookie } = await setupWithEnrolledAnalyst();
    expect((await reset(t, adminCookie, 'ana.perez')).status).toBe(200);
    expect(await auditOf(t, adminCookie)).toEqual([
      {
        id: expect.any(Number),
        ts: expect.any(String),
        module: 'Cuentas',
        record_id: 'ana.perez',
        action: 'MFA_RESET',
        detail: 'MFA restablecido por admin; sesiones revocadas',
      },
    ]);
  });

  it('refuses a user outside the active project and leaves the factor, sessions and audit untouched', async () => {
    const { t, adminCookie } = await setupWithEnrolledAnalyst();
    const other = { ...ANALYST, username: 'bea.rios', full_name: 'Bea Ríos' };
    expect((await t.createAccount(adminCookie, other)).status).toBe(200);
    const created = await t.createScope(adminCookie, {
      company_id: 'SIPGES',
      project_id: 'PRJ-NORTE',
      label: 'Proyecto Norte',
      username: other.username,
    });
    expect(created.status).toBe(200);
    const bea = await t.login(other.username, other.password);
    await enroll(t, bea.cookie);

    const res = await reset(t, adminCookie, 'bea.rios');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: 'Usuario fuera del proyecto activo' });
    expect((await t.request('/api/eventos', { headers: { cookie: bea.cookie } })).status).toBe(200);
    const [row] = await t.sql.query<{ totp_enabled: boolean }>(
      "SELECT totp_enabled FROM users WHERE username = 'bea.rios'",
    );
    expect(row?.totp_enabled).toBe(true);
    expect(await auditOf(t, adminCookie)).toEqual([]);
  });

  it('refuses a project the administrator is not granted', async () => {
    const { t, adminCookie } = await setupWithEnrolledAnalyst();
    const res = await t.request('/system/auth/accounts/ana.perez/reset-mfa', {
      method: 'POST',
      headers: { cookie: adminCookie, 'x-sipges-scope': 'SIPGES/PRJ-AJENO' },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      detail: 'Seleccione un proyecto autorizado mediante X-SIPGES-Scope o /select-project',
    });
    const [row] = await t.sql.query<{ totp_enabled: boolean }>(
      "SELECT totp_enabled FROM users WHERE username = 'ana.perez'",
    );
    expect(row?.totp_enabled).toBe(true);
    expect(await auditOf(t, adminCookie)).toEqual([]);
  });

  it('answers 404 for unknown users and requires a same-origin request', async () => {
    const { t, adminCookie } = await setupWithEnrolledAnalyst();
    expect((await reset(t, adminCookie, 'nobody')).status).toBe(404);
    const crossOrigin = await t.request('/system/auth/accounts/ana.perez/reset-mfa', {
      method: 'POST',
      headers: { cookie: adminCookie, origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
  });
});

describe('admin-cli reset-mfa', () => {
  it('recovers the sole administrator, which the HTTP route refuses', async () => {
    const t = await createTestApp(MFA_ON);
    const admin = await enrolledAdmin(t);
    const store = createSqlIdentityStore(t.sql);

    expect(await runAdminCommand(['reset-mfa', ' Admin '], { store })).toMatchObject({ code: 0 });
    const relogin = await t.login(
      ADMIN.username,
      ADMIN.password,
      totp.codeAt(admin.secret, t.clock.now()),
    );
    const blocked = await t.request('/api/eventos', { headers: { cookie: relogin.cookie } });
    expect(await blocked.json()).toMatchObject({ mfa_required: true });

    expect(await runAdminCommand(['reset-mfa', 'nobody'], { store })).toMatchObject({ code: 1 });
    expect(await runAdminCommand(['reset-mfa'], { store })).toMatchObject({ code: 2 });
  });
});
