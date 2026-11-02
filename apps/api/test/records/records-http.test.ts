import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

type Fixture = Awaited<ReturnType<typeof createTestApp>>;

const setup = async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  expect(admin.res.status).toBe(200);
  const call = (
    method: string,
    path: string,
    body?: unknown,
    options: { cookie?: string; scope?: string } = {},
  ) =>
    t.request(path, {
      method,
      headers: {
        cookie: options.cookie ?? admin.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.scope ? { 'x-sipges-scope': options.scope } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async (module: string, payload: unknown, options = {}) => {
    const res = await call('POST', `/api/${module}`, { payload }, options);
    return { res, body: (await res.json()) as { ok: boolean; id: string } };
  };
  const audit = async (query = '', options = {}) =>
    (await call('GET', `/system/audit${query}`, undefined, options)).json();
  return { t, admin, call, create, audit };
};

const addReader = async (t: Fixture, adminCookie: string) => {
  const created = await t.createAccount(adminCookie, {
    username: 'reader',
    full_name: 'Reader',
    password: 'reader-password-123',
    role: 'consulta',
  });
  expect(created.status).toBe(200);
  await t.grant(adminCookie, 'reader');
  return t.login('reader', 'reader-password-123');
};

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('/api/{module} generic records', () => {
  it('rejects unknown modules with 404 on every method', async () => {
    const { call } = await setup();
    for (const [method, path, body] of [
      ['GET', '/api/planetas'],
      ['GET', '/api/planetas/X'],
      ['POST', '/api/planetas', { payload: {} }],
      ['PUT', '/api/planetas/X', { payload: {} }],
      ['DELETE', '/api/planetas/X'],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Módulo no válido' });
    }
  });

  it('creates records with the module id key, a generated prefix id, or a collision suffix', async () => {
    const { create, call } = await setup();
    const keyed = await create('eventos', { ID_Evento: 'EV-1', Titulo: 'Bloqueo' });
    expect(keyed.res.status).toBe(200);
    expect(keyed.body).toEqual({ ok: true, id: 'EV-1' });

    const generated = await create('alertas', { Titulo: 'Sin id' });
    expect(generated.body.id).toMatch(/^AL-[0-9A-F]{8}$/);
    const fallback = await create('intereses', { Tema: 'Agua' });
    expect(fallback.body.id).toMatch(/^INT-[0-9A-F]{8}$/);

    const collision = await create('eventos', { ID_Evento: 'EV-1', Titulo: 'Otro' });
    expect(collision.body.id).toMatch(/^EV-1-[0-9A-F]{4}$/);
    expect(await (await call('GET', '/api/eventos/EV-1')).json()).toEqual({
      ID_Evento: 'EV-1',
      Titulo: 'Bloqueo',
      Proyecto_ID: 'PRJ-SECHURA',
      _id: 'EV-1',
    });

    const project = await create('proyectos', { Nombre: 'Nuevo' });
    expect(project.body.id).toMatch(/^PRJ-[0-9A-F]{8}$/);
    expect(await (await call('GET', `/api/proyectos/${project.body.id}`)).json()).toEqual({
      Nombre: 'Nuevo',
      Proyecto_ID: project.body.id,
      _id: project.body.id,
    });
  });

  it('lists newest-updated first with _id and _updated_at, filters by q and bounds limit', async () => {
    const { t, create, call } = await setup();
    await create('actores', { ID_Actor: 'A-1', Nombre: 'Comunidad Norte' });
    t.clock.advance(60);
    await create('actores', { ID_Actor: 'A-2', Nombre: 'Gremio Pesquero' });

    const all = await call('GET', '/api/actores');
    expect(all.status).toBe(200);
    const rows = (await all.json()) as Record<string, unknown>[];
    expect(rows.map((row) => row._id)).toEqual(['A-2', 'A-1']);
    expect(rows[0]).toEqual({
      ID_Actor: 'A-2',
      Nombre: 'Gremio Pesquero',
      Proyecto_ID: 'PRJ-SECHURA',
      _id: 'A-2',
      _updated_at: '2026-10-12T12:01:00Z',
    });
    expect(rows[1]?._updated_at).toMatch(ISO_SECONDS);

    const filtered = await call('GET', '/api/actores?q=pesQUERO');
    expect(((await filtered.json()) as { _id: string }[]).map((row) => row._id)).toEqual(['A-2']);
    const byId = await call('GET', '/api/actores?q=a-1');
    expect(((await byId.json()) as { _id: string }[]).map((row) => row._id)).toEqual(['A-1']);

    const one = await call('GET', '/api/actores?limit=1');
    expect(((await one.json()) as unknown[]).length).toBe(1);
    const huge = await call('GET', '/api/actores?limit=100000');
    expect(huge.status).toBe(200);
    expect(((await huge.json()) as unknown[]).length).toBe(2);

    const invalid = await call('GET', '/api/actores?limit=abc');
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({
      detail: [
        {
          type: 'int_parsing',
          loc: ['query', 'limit'],
          msg: 'Input should be a valid integer, unable to parse string as an integer',
        },
      ],
    });
  });

  it('replaces payloads on PUT and returns 404 for missing records', async () => {
    const { t, create, call } = await setup();
    await create('demandas', { ID_Demanda: 'D-1', Estado: 'Abierta', Tema: 'Agua' });
    t.clock.advance(30);
    const put = await call('PUT', '/api/demandas/D-1', { payload: { Estado: 'Cerrada' } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    expect(await (await call('GET', '/api/demandas/D-1')).json()).toEqual({
      Estado: 'Cerrada',
      Proyecto_ID: 'PRJ-SECHURA',
      _id: 'D-1',
    });
    const [listed] = (await (await call('GET', '/api/demandas')).json()) as {
      _updated_at: string;
    }[];
    expect(listed?._updated_at).toBe('2026-10-12T12:00:30Z');

    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { payload: {} }],
    ] as const) {
      const res = await call(method, '/api/demandas/NOPE', body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Registro no encontrado' });
    }
  });

  it('deletes existing records and returns 404 without auditing missing ones', async () => {
    const { create, call, audit } = await setup();
    await create('fuentes', { ID_Fuente: 'F-1' });
    const removed = await call('DELETE', '/api/fuentes/F-1');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await call('GET', '/api/fuentes/F-1')).status).toBe(404);

    const before = await audit();
    const missing = await call('DELETE', '/api/fuentes/F-1');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: 'Registro no encontrado' });
    expect(await audit()).toEqual(before);
  });

  it('rejects invalid payloads with 422 and leaves no record or audit entry', async () => {
    const { call, audit } = await setup();
    const cases: [unknown, unknown][] = [
      [{}, [{ type: 'missing', loc: ['body', 'payload'], msg: 'Field required' }]],
      [
        { payload: ['x'] },
        [{ type: 'invalid_type', loc: ['body', 'payload'], msg: 'Payload must be an object' }],
      ],
      [
        { payload: { Titulo: 'a\u0000b' } },
        [{ type: 'custom', loc: ['body', 'payload'], msg: 'Text must not contain NUL characters' }],
      ],
      [
        { payload: { ID_Evento: { nested: true } } },
        [
          {
            type: 'value_error',
            loc: ['body', 'payload', 'ID_Evento'],
            msg: 'ID_Evento must be a string or number of at most 200 characters',
          },
        ],
      ],
    ];
    for (const [body, detail] of cases) {
      const res = await call('POST', '/api/eventos', body);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ detail });
    }
    const put = await call('PUT', '/api/eventos/X', { payload: { 'k\u0000': 1 } });
    expect(put.status).toBe(422);
    expect(await (await call('GET', '/api/eventos')).json()).toEqual([]);
    expect(await audit()).toEqual([]);
  });

  it('isolates records and audit entries per tenant', async () => {
    const { t, admin, create, call, audit } = await setup();
    expect(
      (
        await t.createScope(admin.cookie, {
          company_id: 'ACME',
          project_id: 'NORTE',
          label: 'North',
          username: 'admin',
        })
      ).status,
    ).toBe(200);
    const north = { scope: 'ACME/NORTE' };
    const south = { scope: 'SIPGES/PRJ-SECHURA' };
    await create('eventos', { ID_Evento: 'EV-N', Titulo: 'Norte' }, north);

    expect(await (await call('GET', '/api/eventos', undefined, south)).json()).toEqual([]);
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { payload: { Titulo: 'hijack' } }],
      ['DELETE', undefined],
    ] as const) {
      expect((await call(method, '/api/eventos/EV-N', body, south)).status).toBe(404);
    }
    expect(await audit('', south)).toEqual([]);

    expect(await (await call('GET', '/api/eventos/EV-N', undefined, north)).json()).toEqual({
      ID_Evento: 'EV-N',
      Titulo: 'Norte',
      Proyecto_ID: 'NORTE',
      _id: 'EV-N',
    });
    expect(((await audit('', north)) as unknown[]).length).toBe(1);
  });

  it('keeps role gates and the body project guard on record routes', async () => {
    const { t, admin, call, create } = await setup();
    await create('eventos', { ID_Evento: 'EV-1' });
    const reader = await addReader(t, admin.cookie);
    const read = await call('GET', '/api/eventos', undefined, { cookie: reader.cookie });
    expect(read.status).toBe(200);
    expect(((await read.json()) as unknown[]).length).toBe(1);
    const write = await call('POST', '/api/eventos', { payload: {} }, { cookie: reader.cookie });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ detail: 'Rol de consulta: solo lectura' });
    const usuarios = await call('GET', '/api/usuarios', undefined, { cookie: reader.cookie });
    expect(usuarios.status).toBe(403);
    expect((await call('GET', '/system/audit', undefined, { cookie: reader.cookie })).status).toBe(
      403,
    );

    const foreign = await call('POST', '/api/eventos', { payload: { project_id: 'OTHER' } });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ detail: 'No se permite escribir en otro proyecto' });
    const anon = await t.request('/api/eventos');
    expect(anon.status).toBe(401);
  });
});

describe('GET /system/audit', () => {
  it('lists create, update and delete entries newest first with a bounded limit', async () => {
    const { t, create, call, audit } = await setup();
    await create('compromisos', { ID_Compromiso: 'C-1' });
    t.clock.advance(1);
    await call('PUT', '/api/compromisos/C-1', { payload: { Estado: 'Cumplido' } });
    t.clock.advance(1);
    await call('DELETE', '/api/compromisos/C-1');

    const entries = (await audit()) as Record<string, unknown>[];
    expect(entries.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        ts: '2026-10-12T12:00:02Z',
        module: 'Compromisos',
        record_id: 'C-1',
        action: 'DELETE',
        detail: 'Registro eliminado',
      },
      {
        ts: '2026-10-12T12:00:01Z',
        module: 'Compromisos',
        record_id: 'C-1',
        action: 'UPDATE',
        detail: 'Registro actualizado',
      },
      {
        ts: '2026-10-12T12:00:00Z',
        module: 'Compromisos',
        record_id: 'C-1',
        action: 'CREATE',
        detail: 'Registro creado desde prototipo V0.2',
      },
    ]);
    const ids = entries.map((entry) => entry.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(typeof ids[0]).toBe('number');
    expect(((await audit('?limit=2')) as unknown[]).length).toBe(2);
    expect(((await audit('?limit=100000')) as unknown[]).length).toBe(3);
    expect((await call('GET', '/system/audit?limit=x')).status).toBe(422);
  });
});

it('paginates the tenant list without changing the legacy array contract', async () => {
  const { create, call } = await setup();
  for (let n = 0; n < 5; n++) await create('directorio', { Nombre: `Contacto de prueba ${n}` });
  const first = (await (await call('GET', '/api/directorio?limit=2')).json()) as { _id: string }[];
  const second = (await (await call('GET', '/api/directorio?limit=2&offset=2')).json()) as {
    _id: string;
  }[];
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
  expect(new Set([...first, ...second].map((row) => row._id)).size).toBe(4);
  expect(await (await call('GET', '/api/directorio?limit=2&offset=4')).json()).toHaveLength(1);
  expect((await call('GET', '/api/directorio?offset=-1')).status).toBe(422);
});
