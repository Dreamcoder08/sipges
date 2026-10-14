import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

type Json = Record<string, unknown>;

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = async (method: string, path: string, body?: unknown, cookie = admin.cookie) => {
    const res = await t.request(path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const account = async (username: string, role: string) => {
    await t.createAccount(admin.cookie, {
      username,
      full_name: username,
      password: `${username}-password-123`,
      role,
    });
    await t.grant(admin.cookie, username);
    return (await t.login(username, `${username}-password-123`)).cookie;
  };
  await call('POST', '/api/actores', {
    payload: { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte' },
  });
  await call('POST', '/api/eventos', {
    payload: {
      ID_Evento: 'EV-1',
      Descripcion_Hecho: 'Reunión reservada',
      Actor_Principal: 'Comunidad Norte',
    },
  });
  await call('POST', '/api/eventos', {
    payload: { ID_Evento: 'EV-2', Descripcion_Hecho: 'Asamblea abierta' },
  });
  return { t, admin, call, account };
};

const ids = (body: unknown) => (body as Json[]).map((row) => row['_id']);

describe('classification markings', () => {
  it('hides restricted records, their history, links and search hits from read-only roles', async () => {
    const { call, account } = await setup();
    const reader = await account('reader', 'consulta');
    const analyst = await account('analyst', 'analista');

    const marked = await call('PUT', '/system/marking', {
      module: 'eventos',
      id: 'EV-1',
      marking: 'restringido',
    });
    expect(marked).toEqual({ status: 200, body: { ok: true, marking: 'restringido' } });

    expect(ids((await call('GET', '/api/eventos', undefined, reader)).body)).toEqual(['EV-2']);
    expect((await call('GET', '/api/eventos/EV-1', undefined, reader)).status).toBe(404);
    expect((await call('GET', '/api/eventos/EV-1/history', undefined, reader)).status).toBe(404);
    expect(
      ((await call('GET', '/system/search?q=reunion', undefined, reader)).body as Json)['hits'],
    ).toEqual([]);
    expect(
      ((await call('GET', '/system/links?module=actores&id=A-1', undefined, reader)).body as Json)[
        'links'
      ],
    ).toEqual([]);
    const graph = (await call('GET', '/system/graph?module=actores&id=A-1', undefined, reader))
      .body as Json;
    expect((graph['nodes'] as Json[]).map((n) => n['id'])).toEqual(['A-1']);

    expect(ids((await call('GET', '/api/eventos', undefined, analyst)).body).sort()).toEqual([
      'EV-1',
      'EV-2',
    ]);
    const links = (await call('GET', '/system/links?module=eventos&id=EV-1', undefined, analyst))
      .body as Json;
    expect(links['record']).toMatchObject({ marking: 'restringido' });

    const exported = (await call('GET', '/system/export')).body as {
      data: { module_records: Json[] };
    };
    expect(exported.data.module_records.map((r) => [r['id'], r['marking']])).toContainEqual([
      'EV-1',
      'restringido',
    ]);
  });

  it('validates, audits and restricts who may classify', async () => {
    const { call, account } = await setup();
    const reader = await account('reader', 'consulta');
    expect(
      (await call('PUT', '/system/marking', { module: 'eventos', id: 'EV-1', marking: 'x' }))
        .status,
    ).toBe(422);
    expect(
      (await call('PUT', '/system/marking', { module: 'eventos', id: 'NOPE', marking: 'publico' }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          'PUT',
          '/system/marking',
          { module: 'eventos', id: 'EV-1', marking: 'publico' },
          reader,
        )
      ).status,
    ).toBe(403);
    await call('PUT', '/system/marking', { module: 'eventos', id: 'EV-1', marking: 'publico' });
    const audit = (await call('GET', '/system/audit')).body as Json[];
    expect(audit[0]).toMatchObject({
      action: 'CLASSIFY',
      record_id: 'EV-1',
      detail: 'Clasificación: interno → publico',
    });
  });
});
