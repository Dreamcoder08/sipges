import { describe, expect, it } from 'vitest';
import { ORIGIN, createTestApp } from '../support/test-app.ts';

const ADMIN = { username: 'admin', password: 'admin-password-123' };
const ANA = {
  username: 'ana.perez',
  full_name: 'Ana Pérez',
  password: 'analyst-pass-123',
  role: 'analista',
};
const NORTE = {
  company_id: 'ACME',
  project_id: 'NORTE',
  label: 'Proyecto Norte',
  username: 'ana.perez',
};
const SECHURA = {
  company_id: 'MASCLI',
  project_id: 'PRJ-SECHURA',
  label: 'Proyecto Sechura (migración)',
};

const json = (res: Response) => res.json() as Promise<unknown>;

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login(ADMIN.username, ADMIN.password);
  await t.createAccount(admin.cookie, ANA);
  return { t, admin };
};

const tenantRows = async (t: Awaited<ReturnType<typeof createTestApp>>) =>
  JSON.stringify([
    await t.sql.query('SELECT * FROM tenants ORDER BY tenant_id'),
    await t.sql.query('SELECT * FROM grants ORDER BY username, tenant_id'),
  ]);

describe('bootstrap', () => {
  it('creates the legacy default project and grants it to admins', async () => {
    const { t, admin } = await setup();
    const res = await t.request('/system/auth/scopes', { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([SECHURA]);
  });

  it('requires a session to list scopes (ADR 0008 #4)', async () => {
    const t = await createTestApp();
    const res = await t.request('/system/auth/scopes');
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: 'Inicie sesión para acceder a MASCLI' });
  });
});

describe('POST /system/auth/scopes', () => {
  it('creates a project, grants it to the named user and keeps it out of other users', async () => {
    const { t, admin } = await setup();
    const res = await t.createScope(admin.cookie, NORTE);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, scope: 'ACME/NORTE' });

    const ana = await t.login(ANA.username, ANA.password);
    expect(
      await json(await t.request('/system/auth/scopes', { headers: { cookie: ana.cookie } })),
    ).toEqual([{ company_id: 'ACME', project_id: 'NORTE', label: 'Proyecto Norte' }]);
    expect(
      await json(await t.request('/system/auth/scopes', { headers: { cookie: admin.cookie } })),
    ).toEqual([SECHURA]);
  });

  it.each([
    [{ ...NORTE, company_id: 'A' }, 422, 'IDs inválidos'],
    [{ ...NORTE, project_id: 'has space' }, 422, 'IDs inválidos'],
    [{ ...NORTE, company_id: 'MASCLI', project_id: 'PRJ-SECHURA' }, 409, 'Proyecto reservado'],
    [{ ...NORTE, username: 'nobody' }, 404, 'Usuario no existe'],
  ])('rejects invalid creation and stores nothing', async (body, status, detail) => {
    const { t, admin } = await setup();
    const before = await tenantRows(t);
    const res = await t.createScope(admin.cookie, body);
    expect(res.status).toBe(status);
    expect(await json(res)).toEqual({ detail });
    expect(await tenantRows(t)).toBe(before);
  });

  it('rejects duplicates with 409 and keeps the original label', async () => {
    const { t, admin } = await setup();
    await t.createScope(admin.cookie, NORTE);
    const res = await t.createScope(admin.cookie, { ...NORTE, label: 'Otro' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ detail: 'Proyecto existente' });
    const [row] = await t.sql.query<{ label: string }>(
      "SELECT label FROM tenants WHERE tenant_id = 'ACME/NORTE'",
    );
    expect(row?.label).toBe('Proyecto Norte');
  });

  it('is restricted to admins', async () => {
    const { t, admin } = await setup();
    await t.grant(admin.cookie, ANA.username);
    const ana = await t.login(ANA.username, ANA.password);
    const res = await t.createScope(ana.cookie, NORTE);
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ detail: 'Administrador requerido' });
  });
});

describe('POST /system/auth/grants', () => {
  it('grants an existing project idempotently', async () => {
    const { t, admin } = await setup();
    await t.createScope(admin.cookie, NORTE);
    await t.grant(admin.cookie, ANA.username);
    await t.grant(admin.cookie, ANA.username);
    const ana = await t.login(ANA.username, ANA.password);
    const scopes = (await json(
      await t.request('/system/auth/scopes', { headers: { cookie: ana.cookie } }),
    )) as {
      project_id: string;
    }[];
    expect(scopes.map((s) => s.project_id).sort()).toEqual(['NORTE', 'PRJ-SECHURA']);
  });

  it.each([
    [
      { username: 'nobody', company_id: 'MASCLI', project_id: 'PRJ-SECHURA' },
      'Usuario inexistente',
    ],
    [{ username: 'ana.perez', company_id: 'NO', project_id: 'PE' }, 'Proyecto inexistente'],
  ])('answers 404 for missing references and stores nothing', async (body, detail) => {
    const { t, admin } = await setup();
    const before = await tenantRows(t);
    const res = await t.request('/system/auth/grants', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ detail });
    expect(await tenantRows(t)).toBe(before);
  });

  it('is restricted to admins with the FastAPI default body', async () => {
    const { t, admin } = await setup();
    await t.grant(admin.cookie, ANA.username);
    const ana = await t.login(ANA.username, ANA.password);
    const res = await t.request('/system/auth/grants', {
      method: 'POST',
      headers: { cookie: ana.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'ana.perez',
        company_id: 'MASCLI',
        project_id: 'PRJ-SECHURA',
      }),
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ detail: 'Forbidden' });
  });
});

describe('scope resolution middleware (app.py enforce_auth steps 4-7)', () => {
  const multiScopeAdmin = async () => {
    const { t, admin } = await setup();
    await t.createScope(admin.cookie, NORTE);
    await t.grant(admin.cookie, ADMIN.username, 'ACME/NORTE');
    return { t, admin };
  };

  it('uses the sole grant when no scope was requested', async () => {
    const { t, admin } = await setup();
    const res = await t.request('/system/auth/current-scope', {
      headers: { cookie: admin.cookie },
    });
    expect(await json(res)).toEqual({
      company_id: 'MASCLI',
      project_id: 'PRJ-SECHURA',
      scope: 'MASCLI/PRJ-SECHURA',
    });
  });

  it('asks to choose when several grants exist and lists them', async () => {
    const { t, admin } = await multiScopeAdmin();
    const res = await t.request('/system/auth/current-scope', {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(403);
    const body = (await json(res)) as { detail: string; projects: string[] };
    expect(body.detail).toBe(
      'Seleccione un proyecto autorizado mediante X-MASCLI-Scope o /select-project',
    );
    expect(body.projects.sort()).toEqual(['ACME/NORTE', 'MASCLI/PRJ-SECHURA']);
  });

  it('honours X-MASCLI-Scope and rejects scopes that are not granted', async () => {
    const { t, admin } = await multiScopeAdmin();
    const ok = await t.request('/system/auth/current-scope', {
      headers: { cookie: admin.cookie, 'x-mascli-scope': 'ACME/NORTE' },
    });
    expect(await json(ok)).toEqual({
      company_id: 'ACME',
      project_id: 'NORTE',
      scope: 'ACME/NORTE',
    });
    const denied = await t.request('/system/auth/current-scope', {
      headers: { cookie: admin.cookie, 'x-mascli-scope': 'EVIL/CORP' },
    });
    expect(denied.status).toBe(403);
  });

  it('denies every scoped route to a user without grants', async () => {
    const { t } = await setup();
    const ana = await t.login(ANA.username, ANA.password);
    const res = await t.request('/system/auth/totp/setup', {
      method: 'POST',
      headers: { cookie: ana.cookie },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({
      detail: 'Seleccione un proyecto autorizado mediante X-MASCLI-Scope o /select-project',
      projects: [],
    });
  });

  it('rejects a query project_id outside the active scope', async () => {
    const { t, admin } = await setup();
    const res = await t.request('/system/auth/current-scope?project_id=NORTE', {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ detail: 'Proyecto fuera de alcance' });
  });

  it.each([
    { project_id: 'NORTE' },
    { payload: { Proyecto_ID: 'NORTE' } },
    { payload: { project_id: 'NORTE' } },
  ])(
    'rejects a JSON body that targets another project (%j) before the handler runs',
    async (body) => {
      const { t, admin } = await setup();
      const res = await t.request('/system/auth/totp/setup', {
        method: 'POST',
        headers: { cookie: admin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(await json(res)).toEqual({ detail: 'No se permite escribir en otro proyecto' });
      const [row] = await t.sql.query<{ totp_secret_sealed: string | null }>(
        "SELECT totp_secret_sealed FROM users WHERE username = 'admin'",
      );
      expect(row?.totp_secret_sealed).toBeNull();
    },
  );

  it('lets a JSON body that names the active project through', async () => {
    const { t, admin } = await setup();
    const res = await t.request('/system/auth/totp/setup', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'PRJ-SECHURA' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('/select-project', () => {
  it('redirects anonymous visitors to the login page', async () => {
    const t = await createTestApp();
    const res = await t.request('/select-project');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('lists only granted projects with HTML-escaped labels', async () => {
    const { t, admin } = await setup();
    await t.createScope(admin.cookie, {
      ...NORTE,
      label: '<script>alert(1)</script>',
      username: 'admin',
    });
    const res = await t.request('/select-project', { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain(
      '<option value="ACME/NORTE">&lt;script&gt;alert(1)&lt;/script&gt; (ACME/NORTE)</option>',
    );
    expect(html).toContain('<option value="MASCLI/PRJ-SECHURA">');
    expect(html).not.toContain('<script>');
  });

  it('stores a granted choice in the scope cookie and redirects home', async () => {
    const { t, admin } = await setup();
    await t.createScope(admin.cookie, { ...NORTE, username: 'admin' });
    const res = await t.request('/select-project', {
      method: 'POST',
      headers: { cookie: admin.cookie, origin: ORIGIN },
      body: t.form({ scope: 'ACME/NORTE' }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^mascli_scope=/);
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=28800', 'Path=/']) {
      expect(cookie).toContain(flag);
    }
    const scopeCookie = cookie.split(';')[0] ?? '';
    const current = await t.request('/system/auth/current-scope', {
      headers: { cookie: `${admin.cookie}; ${scopeCookie}` },
    });
    expect(await json(current)).toEqual({
      company_id: 'ACME',
      project_id: 'NORTE',
      scope: 'ACME/NORTE',
    });
  });

  it('refuses projects that are not granted', async () => {
    const { t, admin } = await setup();
    const res = await t.request('/select-project', {
      method: 'POST',
      headers: { cookie: admin.cookie },
      body: t.form({ scope: 'EVIL/CORP' }),
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ detail: 'Proyecto no autorizado' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('requires a session to choose', async () => {
    const t = await createTestApp();
    const res = await t.request('/select-project', {
      method: 'POST',
      body: t.form({ scope: 'MASCLI/PRJ-SECHURA' }),
    });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ detail: 'Unauthorized' });
  });

  it('rejects cross-origin choices', async () => {
    const { t, admin } = await setup();
    const res = await t.request('/select-project', {
      method: 'POST',
      headers: { cookie: admin.cookie, origin: 'https://evil.example' },
      body: t.form({ scope: 'MASCLI/PRJ-SECHURA' }),
    });
    expect(res.status).toBe(403);
  });
});
