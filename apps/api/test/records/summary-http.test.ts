import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

type Fixture = Awaited<ReturnType<typeof createTestApp>>;
type Summary = {
  counts: Record<string, number>;
  rows: Record<string, unknown>[];
};

const NO_RECORDS = {
  eventos: 0,
  actores: 0,
  directorio: 0,
  demandas: 0,
  narrativas: 0,
  fuentes: 0,
  buzon: 0,
};

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
    expect(res.status).toBe(200);
  };
  const summary = async (query = '', options = {}) => {
    const res = await call('GET', `/api/registros/summary${query}`, undefined, options);
    expect(res.status).toBe(200);
    return (await res.json()) as Summary;
  };
  return { t, admin, call, create, summary };
};

const account = async (t: Fixture, adminCookie: string, username: string, role: string) => {
  const created = await t.createAccount(adminCookie, {
    username,
    full_name: username,
    password: `${username}-password-123`,
    role,
  });
  expect(created.status).toBe(200);
  await t.grant(adminCookie, username);
  return (await t.login(username, `${username}-password-123`)).cookie;
};

const keys = (body: Summary) => body.rows.map((row) => `${String(row.module)}/${String(row.id)}`);

describe('GET /api/registros/summary', () => {
  it('returns the shared columns of every hub type, in chip order and newest first, with counts', async () => {
    const { t, create, summary } = await setup();
    await create('eventos', {
      ID_Evento: 'EV-1',
      Descripcion_Hecho: 'Asamblea comunal',
      Territorio: 'Sechura',
      Fecha: '2026-10-01',
      Nivel_Verificacion: 'B - Corroborada',
      Estado_Validacion: 'Validado',
    });
    t.clock.advance(60);
    await create('eventos', { ID_Evento: 'EV-2', Nivel_Verificacion: 'Por verificar' });
    await create('directorio', {
      'Nombre actualizado 2026': 'Contacto sintético',
      Ciudad: 'Piura',
    });
    await create('fuentes', {
      ID_Fuente: 'F-1',
      Archivo_Fuente: 'informe.pdf',
      Fecha_Documento: '2026-09-30',
      Nivel_Base_Verificacion: 'A - Confirmada',
    });
    await create('compromisos', { ID_Compromiso: 'C-1', Descripcion: 'Fuera del hub' });

    const body = await summary();
    expect(body.counts).toEqual({ ...NO_RECORDS, eventos: 2, directorio: 1, fuentes: 1 });
    expect(keys(body).filter((key) => !key.startsWith('directorio/'))).toEqual([
      'eventos/EV-2',
      'eventos/EV-1',
      'fuentes/F-1',
    ]);
    expect(body.rows[1]).toEqual({
      module: 'eventos',
      id: 'EV-1',
      title: 'Asamblea comunal',
      territory: 'Sechura',
      date: '2026-10-01',
      verification: 'B',
      validation: 'Validado',
      updated_at: '2026-10-12T12:00:00Z',
    });
    // No title falls back to the id; a wording without a grade has no A–E letter.
    expect(body.rows[0]).toMatchObject({ id: 'EV-2', title: 'EV-2', verification: null });
    // Imported directory aliases are read like the type screen reads them.
    expect(body.rows[2]).toMatchObject({
      module: 'directorio',
      title: 'Contacto sintético',
      territory: 'Piura',
      date: '',
      verification: null,
    });
    expect(body.rows[3]).toMatchObject({ date: '2026-09-30', verification: 'A' });
  });

  it('pages, bounds and searches like the per-type lists', async () => {
    const { t, call, create, summary } = await setup();
    for (let n = 0; n < 3; n++) {
      await create('actores', { ID_Actor: `A-${n}`, 'Nombre_Actor/Organizacion': `Gremio ${n}` });
      t.clock.advance(60);
    }
    await create('demandas', { ID_Demanda: 'D-1', Descripcion: 'Agua potable para Gremio 1' });

    const first = await summary('?limit=2');
    const second = await summary('?limit=2&offset=2');
    expect(keys(first)).toEqual(['actores/A-2', 'actores/A-1']);
    expect(keys(second)).toEqual(['actores/A-0', 'demandas/D-1']);
    expect(first.counts).toEqual({ ...NO_RECORDS, actores: 3, demandas: 1 });
    expect((await summary('?limit=100000')).rows).toHaveLength(4);

    const searched = await summary('?q=gremio%201');
    expect(keys(searched)).toEqual(['actores/A-1', 'demandas/D-1']);
    expect(searched.counts).toEqual({ ...NO_RECORDS, actores: 1, demandas: 1 });

    const invalid = await call('GET', '/api/registros/summary?limit=abc');
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
    expect((await call('GET', '/api/registros/summary?offset=-1')).status).toBe(422);
  });

  it("never returns another project's records or counts", async () => {
    const { t, admin, create, summary } = await setup();
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
    await create('eventos', { ID_Evento: 'EV-N', Descripcion_Hecho: 'Norte' }, north);
    await create('eventos', { ID_Evento: 'EV-S', Descripcion_Hecho: 'Sur' }, south);

    const southern = await summary('', south);
    expect(keys(southern)).toEqual(['eventos/EV-S']);
    expect(southern.counts).toEqual({ ...NO_RECORDS, eventos: 1 });
    expect(keys(await summary('?q=norte', south))).toEqual([]);
    expect(keys(await summary('', north))).toEqual(['eventos/EV-N']);
  });

  it('hides restricted records from read-only roles and requires a session', async () => {
    const { t, admin, call, create, summary } = await setup();
    await create('eventos', { ID_Evento: 'EV-1', Descripcion_Hecho: 'Reunión sintética' });
    await create('eventos', { ID_Evento: 'EV-2', Descripcion_Hecho: 'Asamblea abierta' });
    const marked = await call('PUT', '/system/marking', {
      module: 'eventos',
      id: 'EV-1',
      marking: 'restringido',
    });
    expect(marked.status).toBe(200);
    const reader = await account(t, admin.cookie, 'reader', 'consulta');
    const analyst = await account(t, admin.cookie, 'analyst', 'analista');

    const limited = await summary('', { cookie: reader });
    expect(keys(limited)).toEqual(['eventos/EV-2']);
    expect(limited.counts).toEqual({ ...NO_RECORDS, eventos: 1 });
    const full = await summary('', { cookie: analyst });
    expect(keys(full).sort()).toEqual(['eventos/EV-1', 'eventos/EV-2']);
    expect(full.counts).toEqual({ ...NO_RECORDS, eventos: 2 });

    expect((await t.request('/api/registros/summary')).status).toBe(401);
    // The per-type routes keep their meaning: «registros» is not a record type.
    expect((await call('GET', '/api/registros')).status).toBe(404);
  });
});
