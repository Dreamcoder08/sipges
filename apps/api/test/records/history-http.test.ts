import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

type Version = {
  version: number;
  operation: string;
  actor: string;
  at: string;
  payload: Record<string, unknown> | null;
  changes: { field: string; before?: unknown; after?: unknown }[];
};

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = (method: string, path: string, body?: unknown, cookie = admin.cookie) =>
    t.request(path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const history = async (path: string, cookie = admin.cookie) => {
    const res = await call('GET', `${path}/history`, undefined, cookie);
    return { status: res.status, body: (await res.json()) as Version[] };
  };
  return { t, admin, call, history };
};

describe('GET /api/{module}/{id}/history', () => {
  it('records every change with its actor and field differences, newest first', async () => {
    const { t, call, history } = await setup();
    await call('POST', '/api/actores', {
      payload: { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte' },
    });
    t.clock.advance(60);
    await call('PUT', '/api/actores/A-1', {
      payload: { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte', Tipo: 'Comunal' },
    });
    t.clock.advance(60);
    await call('PUT', '/api/actores/A-1', {
      payload: { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad del Norte' },
    });

    const { status, body } = await history('/api/actores/A-1');
    expect(status).toBe(200);
    expect(body.map((v) => [v.version, v.operation, v.actor])).toEqual([
      [3, 'UPDATE', 'admin'],
      [2, 'UPDATE', 'admin'],
      [1, 'CREATE', 'admin'],
    ]);
    expect(body[0]?.at).toBe('2026-10-12T12:02:00Z');
    expect(body[0]?.changes).toEqual([
      {
        field: 'Nombre_Actor/Organizacion',
        before: 'Comunidad Norte',
        after: 'Comunidad del Norte',
      },
      { field: 'Tipo', before: 'Comunal' },
    ]);
    expect(body[2]?.changes.map((c) => c.field)).toEqual(['ID_Actor', 'Nombre_Actor/Organizacion']);
  });

  it('skips writes that change nothing and keeps the history after deletion', async () => {
    const { call, history } = await setup();
    const payload = { ID_Evento: 'EV-1', Descripcion_Hecho: 'Asamblea' };
    await call('POST', '/api/eventos', { payload });
    await call('PUT', '/api/eventos/EV-1', { payload });
    await call('DELETE', '/api/eventos/EV-1');
    const { status, body } = await history('/api/eventos/EV-1');
    expect(status).toBe(200);
    expect(body.map((v) => v.operation)).toEqual(['DELETE', 'CREATE']);
    expect(body[0]?.payload).toBeNull();
  });

  it('answers 404 for unknown records and modules', async () => {
    const { history } = await setup();
    expect((await history('/api/eventos/NOPE')).status).toBe(404);
    expect((await history('/api/planetas/X')).status).toBe(404);
  });

  it('is append-only and isolated per tenant', async () => {
    const { t, admin, call } = await setup();
    await call('POST', '/api/eventos', { payload: { ID_Evento: 'EV-9', Descripcion_Hecho: 'x' } });
    const created = await t.createScope(admin.cookie, {
      company_id: 'OTRA',
      project_id: 'PRJ-B',
      label: 'Otra',
      username: 'admin',
    });
    expect(created.status).toBe(200);
    const other = await t.request('/api/eventos/EV-9/history', {
      headers: { cookie: admin.cookie, 'x-sipges-scope': 'OTRA/PRJ-B' },
    });
    expect(other.status).toBe(404);

    await expect(
      t.sql.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.tenant_id', 'SIPGES/PRJ-SECHURA', true)");
        await tx.exec('SET LOCAL ROLE sipges_tenant');
        await tx.exec("UPDATE record_versions SET actor = 'intruder'");
      }),
    ).rejects.toThrow(/permission denied/);
    const own = await t.request('/api/eventos/EV-9/history', {
      headers: { cookie: admin.cookie, 'x-sipges-scope': 'SIPGES/PRJ-SECHURA' },
    });
    expect(((await own.json()) as Version[])[0]?.actor).toBe('admin');
  });
});
