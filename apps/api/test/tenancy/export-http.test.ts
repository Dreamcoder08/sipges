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
        marking: 'interno',
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
        event_payload: null,
      },
    ],
    attachments: [],
    document_review: [],
    digital_alert_reviews: [],
    preventive_actions: [],
    preventive_action_log: [],
    record_versions: [
      {
        id: expect.any(Number),
        tenant_id: `${company}/${project}`,
        module: 'Eventos',
        record_id: id,
        operation: 'CREATE',
        payload: { ID_Evento: id, name },
        actor: 'admin',
        at: '2026-10-12T12:00:00.000Z',
        marking: 'interno',
      },
    ],
    record_links: [],
    automation_rules: [],
    automation_runs: [],
    notifications: [],
    source_import_settings: [],
    project_settings: [],
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

  it('preserves authorized source configuration and immutable digital audit snapshots only in its tenant export', async () => {
    const { t, admin } = await setup();
    await t.grant(admin.cookie, 'admin', 'ACME/NORTE');
    for (const [scope, label] of [
      ['MASCLI/PRJ-SECHURA', 'Synthetic source A'],
      ['ACME/NORTE', 'Synthetic source B'],
    ] as const) {
      await t.container.authorizedSources.configure(
        scope,
        {
          enabled: false,
          query: label,
          territory: `${label} territory`,
          authorization_note: `${label} authorization`,
        },
        'admin',
      );
    }
    const sourceUrl = 'https://example.test/synthetic-export-evidence';
    const created = await t.request('/system/intelligence/territorial-alerts', {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        'content-type': 'application/json',
        'x-mascli-scope': 'MASCLI/PRJ-SECHURA',
      },
      body: JSON.stringify({
        text: 'Exigimos agua limpia: habrá paro y bloqueo. Convocatoria a asamblea.',
        source_url: sourceUrl,
        source_type: 'Publicación digital',
        mode: 'rules',
        territory: 'Synthetic documented export territory',
        project_id: 'PRJ-SECHURA',
      }),
    });
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const reviewed = await t.request(`/system/intelligence/territorial-alerts/${id}`, {
      method: 'PATCH',
      headers: {
        cookie: admin.cookie,
        'content-type': 'application/json',
        'x-mascli-scope': 'MASCLI/PRJ-SECHURA',
      },
      body: JSON.stringify({ status: 'Corroborado', reviewer_note: 'Synthetic human review' }),
    });
    expect(reviewed.status).toBe(200);
    const response = await exportRequest(t, admin.cookie, 'MASCLI/PRJ-SECHURA');
    expect(response.status).toBe(200);
    const exported = (await response.json()) as { data: Record<string, Record<string, unknown>[]> };
    expect(exported.data.source_import_settings).toEqual([
      expect.objectContaining({
        tenant_id: 'MASCLI/PRJ-SECHURA',
        source_id: 'defensoria',
        enabled: false,
        query: 'Synthetic source A',
        territory: 'Synthetic source A territory',
        authorization_note: 'Synthetic source A authorization',
        revision: 1,
        updated_by: 'admin',
      }),
    ]);
    const digitalEvents = exported.data.audit?.filter(
      (event) => event.module === 'InteligenciaDigital' && event.record_id === id,
    );
    expect(digitalEvents).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        event_payload: expect.objectContaining({
          id,
          status: 'Pendiente de verificación',
          source_url: sourceUrl,
          territory: 'Synthetic documented export territory',
        }),
      }),
      expect.objectContaining({
        action: 'REVIEW',
        event_payload: expect.objectContaining({
          id,
          status: 'Corroborado',
          source_url: sourceUrl,
          territory: 'Synthetic documented export territory',
        }),
      }),
    ]);
    expect(exported.data.digital_alert_reviews).toEqual([
      expect.objectContaining({ id, status: 'Corroborado' }),
    ]);
    expect(JSON.stringify(exported)).not.toContain('Synthetic source B');
    for (const operational of [
      'automation_cursors',
      'digital_signal_dedup_locks',
      'push_subscriptions',
      'integration_channels',
    ])
      expect(exported.data).not.toHaveProperty(operational);
    const northResponse = await exportRequest(t, admin.cookie, 'ACME/NORTE');
    expect(northResponse.status).toBe(200);
    const north = (await northResponse.json()) as {
      data: Record<string, Record<string, unknown>[]>;
    };
    expect(north.data.source_import_settings).toEqual([
      expect.objectContaining({ tenant_id: 'ACME/NORTE', query: 'Synthetic source B' }),
    ]);
    expect(north.data.digital_alert_reviews).toEqual([]);
    expect(JSON.stringify(north)).not.toContain(sourceUrl);
    expect(JSON.stringify(north)).not.toContain('Synthetic source A');
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
      data: {
        module_records: [],
        audit: [],
        attachments: [],
        document_review: [],
        digital_alert_reviews: [],
        preventive_actions: [],
        preventive_action_log: [],
        record_versions: [],
        record_links: [],
        automation_rules: [],
        automation_runs: [],
        notifications: [],
        source_import_settings: [],
        project_settings: [],
      },
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
