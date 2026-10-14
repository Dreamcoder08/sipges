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
    return { status: res.status, body: (await res.json()) as Json };
  };
  const create = async (module: string, payload: Json) => {
    const res = await call('POST', `/api/${module}`, { payload });
    expect(res.status).toBe(200);
    return res.body['id'] as string;
  };
  const link = (link_type: string, source: [string, string], target: [string, string], note = '') =>
    call('POST', '/system/links', {
      link_type,
      source: { module: source[0], id: source[1] },
      target: { module: target[0], id: target[1] },
      note,
    });
  return { t, admin, call, create, link };
};

const seed = async (s: Awaited<ReturnType<typeof setup>>) => {
  await s.create('actores', { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Comunidad Norte' });
  await s.create('actores', { ID_Actor: 'A-2', 'Nombre_Actor/Organizacion': 'Frente Sur' });
  await s.create('fuentes', { ID_Fuente: 'F-1', Archivo_Fuente: 'Acta de asamblea' });
  await s.create('eventos', {
    ID_Evento: 'EV-1',
    Descripcion_Hecho: 'Asamblea comunal',
    Fecha: '2026-10-01',
    Actor_Principal: '  comunidad norte ',
    Fuente_ID: 'F-1',
  });
  await s.create('demandas', { ID_Demanda: 'D-1', Descripcion: 'Agua potable' });
};

describe('ontology catalog and typed links', () => {
  it('serves the catalog', async () => {
    const { call } = await setup();
    const { status, body } = await call('GET', '/system/ontology');
    expect(status).toBe(200);
    const types = body['object_types'] as Json[];
    expect(types.find((t) => t['module'] === 'actores')).toMatchObject({
      label: 'Actor',
      title_field: 'Nombre_Actor/Organizacion',
    });
    expect((body['link_types'] as Json[]).map((t) => t['id'])).toContain('participa_en');
  });

  it('creates, lists from both ends, and deletes explicit links with audit', async () => {
    const s = await setup();
    await seed(s);
    const created = await s.link('plantea', ['actores', 'A-2'], ['demandas', 'D-1'], 'Mesa 1');
    expect(created).toEqual({ status: 200, body: { ok: true, id: expect.any(Number) } });

    const fromActor = await s.call('GET', '/system/links?module=actores&id=A-2');
    expect(fromActor.status).toBe(200);
    expect(fromActor.body['record']).toMatchObject({ module: 'actores', title: 'Frente Sur' });
    expect(fromActor.body['links']).toEqual([
      {
        edge: {
          id: created.body['id'],
          link_type: 'plantea',
          source: { module: 'actores', id: 'A-2' },
          target: { module: 'demandas', id: 'D-1' },
          inferred: false,
          via: null,
          note: 'Mesa 1',
          created_by: 'admin',
          created_at: '2026-10-12T12:00:00Z',
        },
        direction: 'out',
        label: 'plantea',
        other: expect.objectContaining({ module: 'demandas', id: 'D-1', title: 'Agua potable' }),
      },
    ]);
    const fromDemand = await s.call('GET', '/system/links?module=demandas&id=D-1');
    expect(fromDemand.body['links']).toMatchObject([
      { direction: 'in', label: 'es planteada por', other: { id: 'A-2' } },
    ]);

    expect((await s.link('plantea', ['actores', 'A-2'], ['demandas', 'D-1'])).status).toBe(409);
    expect((await s.call('DELETE', `/system/links/${created.body['id']}`)).status).toBe(200);
    expect((await s.call('DELETE', `/system/links/${created.body['id']}`)).status).toBe(404);
    expect((await s.call('GET', '/system/links?module=demandas&id=D-1')).body['links']).toEqual([]);

    const audit = (await s.call('GET', '/system/audit')).body as unknown as Json[];
    expect(audit.filter((row) => row['module'] === 'Vinculos').map((r) => r['action'])).toEqual([
      'DELETE',
      'CREATE',
    ]);
  });

  it('rejects invalid links', async () => {
    const s = await setup();
    await seed(s);
    expect(await s.link('participa_en', ['eventos', 'EV-1'], ['actores', 'A-1'])).toEqual({
      status: 422,
      body: { detail: 'El tipo de vínculo no admite esos tipos de objeto' },
    });
    expect((await s.link('inventado', ['actores', 'A-1'], ['eventos', 'EV-1'])).status).toBe(422);
    expect((await s.link('aliado_de', ['actores', 'A-1'], ['actores', 'A-1'])).status).toBe(422);
    expect((await s.link('participa_en', ['actores', 'A-9'], ['eventos', 'EV-1'])).status).toBe(
      404,
    );
    expect((await s.call('POST', '/system/links', { link_type: 'x' })).status).toBe(422);
    expect((await s.call('GET', '/system/links?module=actores&id=NOPE')).status).toBe(404);
  });

  it('stores symmetric links once', async () => {
    const s = await setup();
    await seed(s);
    expect((await s.link('aliado_de', ['actores', 'A-1'], ['actores', 'A-2'])).status).toBe(200);
    expect((await s.link('aliado_de', ['actores', 'A-2'], ['actores', 'A-1'])).status).toBe(409);
  });

  it('infers links from reference fields and actor names', async () => {
    const s = await setup();
    await seed(s);
    const { body } = await s.call('GET', '/system/links?module=eventos&id=EV-1');
    const links = body['links'] as Json[];
    expect(
      links.map((l) => [l['label'], (l['other'] as Json)['id'], (l['edge'] as Json)['via']]),
    ).toEqual([
      ['se sustenta en', 'F-1', 'Fuente_ID'],
      ['tiene como participante a', 'A-1', 'Actor_Principal'],
    ]);
    expect(links.every((l) => (l['edge'] as Json)['inferred'] === true)).toBe(true);
  });

  it('drops links when a linked record is deleted', async () => {
    const s = await setup();
    await seed(s);
    await s.link('plantea', ['actores', 'A-2'], ['demandas', 'D-1']);
    expect((await s.call('DELETE', '/api/demandas/D-1')).status).toBe(200);
    expect((await s.call('GET', '/system/links?module=actores&id=A-2')).body['links']).toEqual([]);
  });

  it('builds a bounded n-hop graph', async () => {
    const s = await setup();
    await seed(s);
    await s.link('plantea', ['actores', 'A-1'], ['demandas', 'D-1']);
    const one = await s.call('GET', '/system/graph?module=fuentes&id=F-1');
    expect(one.status).toBe(200);
    expect((one.body['nodes'] as Json[]).map((n) => n['id']).sort()).toEqual(['EV-1', 'F-1']);
    const two = await s.call('GET', '/system/graph?module=fuentes&id=F-1&depth=2');
    expect((two.body['nodes'] as Json[]).map((n) => n['id']).sort()).toEqual([
      'A-1',
      'EV-1',
      'F-1',
    ]);
    const three = await s.call('GET', '/system/graph?module=fuentes&id=F-1&depth=9');
    expect((three.body['nodes'] as Json[]).length).toBe(3);
    expect(two.body['edges']).toHaveLength(2);
    expect(two.body['truncated']).toBe(false);
    expect((await s.call('GET', '/system/graph?module=fuentes&id=NOPE')).status).toBe(404);
    expect((await s.call('GET', '/system/graph?module=fuentes&id=F-1&depth=x')).status).toBe(422);
  });

  it('keeps read-only roles from writing and tenants apart', async () => {
    const s = await setup();
    await seed(s);
    await s.t.createAccount(s.admin.cookie, {
      username: 'reader',
      full_name: 'Reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await s.t.grant(s.admin.cookie, 'reader');
    const reader = await s.t.login('reader', 'reader-password-123');
    const denied = await s.call(
      'POST',
      '/system/links',
      {
        link_type: 'plantea',
        source: { module: 'actores', id: 'A-1' },
        target: { module: 'demandas', id: 'D-1' },
      },
      reader.cookie,
    );
    expect(denied.status).toBe(403);
    expect(
      (await s.call('GET', '/system/links?module=actores&id=A-1', undefined, reader.cookie)).status,
    ).toBe(200);

    await s.t.createScope(s.admin.cookie, {
      company_id: 'OTRA',
      project_id: 'PRJ-B',
      label: 'Otra',
      username: 'admin',
    });
    const other = await s.t.request('/system/links?module=actores&id=A-1', {
      headers: { cookie: s.admin.cookie, 'x-mascli-scope': 'OTRA/PRJ-B' },
    });
    expect(other.status).toBe(404);
  });
});
