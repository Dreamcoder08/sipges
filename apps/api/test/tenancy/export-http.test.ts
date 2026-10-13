import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  // Seed one record per tenant through the public API, then keep the admin on Sechura only.
  const north = { company_id: 'ACME', project_id: 'NORTE' };
  expect(
    (await t.createScope(admin.cookie, { ...north, label: 'North', username: 'admin' })).status,
  ).toBe(200);
  for (const [scope, id, name] of [
    ['MASCLI/PRJ-SECHURA', 'a', 'Sechura-only'],
    ['ACME/NORTE', 'b', 'North-only'],
  ] as const) {
    const res = await t.request('/api/eventos', {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        'content-type': 'application/json',
        'x-mascli-scope': scope,
      },
      body: JSON.stringify({ payload: { ID_Evento: id, name } }),
    });
    expect(res.status).toBe(200);
  }
  const revoked = await t.request('/system/auth/grants', {
    method: 'DELETE',
    headers: { cookie: admin.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', ...north }),
  });
  expect(revoked.status).toBe(200);
  return { t, admin };
};
const exportRequest = (
  t: Awaited<ReturnType<typeof createTestApp>>,
  cookie: string,
  scope?: string,
) =>
  t.request('/system/export', {
    headers: { cookie, ...(scope ? { 'x-mascli-scope': scope } : {}) },
  });
const expected = (
  company = 'MASCLI',
  project = 'PRJ-SECHURA',
  id = 'a',
  name = 'Sechura-only',
) => ({
  format: 'mascli.tenant-export',
  version: 1,
  scope: { company_id: company, project_id: project },
  exported_at: '2026-10-12T12:00:00Z',
  data: {
    module_records: [
      {
        tenant_id: `${company}/${project}`,
        module: 'Eventos',
        id,
        payload: { ID_Evento: id, name },
        created_at: '2026-10-12T12:00:00.000Z',
        updated_at: '2026-10-12T12:00:00.000Z',
      },
    ],
    audit: [
      {
        id: expect.any(Number),
        tenant_id: `${company}/${project}`,
        ts: '2026-10-12T12:00:00.000Z',
        module: 'Eventos',
        record_id: id,
        action: 'CREATE',
        detail: 'Registro creado desde prototipo V0.2',
      },
    ],
    attachments: [],
    document_review: [],
  },
});

describe('GET /system/export versioned tenant JSON', () => {
  it('downloads only active-tenant business data without auth tables or credentials', async () => {
    const { t, admin } = await setup();
    const res = await exportRequest(t, admin.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=UTF-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="mascli-tenant.json"',
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(expected());
    for (const forbidden of [
      'North-only',
      'password_hash',
      'token_hash',
      'totp_secret',
      '$argon2id$',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(await (await exportRequest(t, admin.cookie)).json()).toEqual(expected());
  });

  it('honours selected granted tenant and restores identity access after export', async () => {
    const { t, admin } = await setup();
    await t.grant(admin.cookie, 'admin', 'ACME/NORTE');
    const north = await exportRequest(t, admin.cookie, 'ACME/NORTE');
    expect(north.status).toBe(200);
    expect(await north.json()).toEqual(expected('ACME', 'NORTE', 'b', 'North-only'));
    const south = await exportRequest(t, admin.cookie, 'MASCLI/PRJ-SECHURA');
    expect(await south.json()).toEqual(expected());
    const me = await t.request('/system/auth/me', { headers: { cookie: admin.cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ username: 'admin' });
  });

  it('requires a session and admin role without changing exported data', async () => {
    const { t, admin } = await setup();
    const anon = await t.request('/system/export');
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ detail: 'Inicie sesión para acceder a MASCLI' });
    expect(
      (
        await t.createAccount(admin.cookie, {
          username: 'reader',
          full_name: 'Reader',
          password: 'reader-password-123',
          role: 'consulta',
        })
      ).status,
    ).toBe(200);
    await t.grant(admin.cookie, 'reader');
    const user = await t.login('reader', 'reader-password-123');
    const denied = await exportRequest(t, user.cookie);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ detail: 'Requiere rol administrador' });
    expect(await (await exportRequest(t, admin.cookie)).json()).toEqual(expected());
  });

  it('rejects an ungranted tenant and mismatching project query before export', async () => {
    const { t, admin } = await setup();
    const ungranted = await exportRequest(t, admin.cookie, 'OTHER/SECRET');
    expect(ungranted.status).toBe(403);
    expect(await ungranted.json()).toEqual({
      detail: 'Seleccione un proyecto autorizado mediante X-MASCLI-Scope o /select-project',
      projects: ['MASCLI/PRJ-SECHURA'],
    });
    const mismatch = await t.request('/system/export?project_id=NORTE', {
      headers: { cookie: admin.cookie },
    });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toEqual({ detail: 'Proyecto fuera de alcance' });
    expect(await (await exportRequest(t, admin.cookie)).json()).toEqual(expected());
  });

  it('exports empty arrays for a tenant without business data', async () => {
    const t = await createTestApp();
    const admin = await t.login('admin', 'admin-password-123');
    const res = await exportRequest(t, admin.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...expected(),
      data: { module_records: [], audit: [], attachments: [], document_review: [] },
    });
  });

  it('fails closed on missing table privileges without returning partial data', async () => {
    const { t, admin } = await setup();
    await t.sql.exec('REVOKE SELECT ON audit FROM mascli_tenant');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await exportRequest(t, admin.cookie);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
      expect(log).toHaveBeenCalledTimes(1);
      const me = await t.request('/system/auth/me', { headers: { cookie: admin.cookie } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ username: 'admin' });
    } finally {
      log.mockRestore();
    }
  });
});
