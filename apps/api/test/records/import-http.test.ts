import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

type Report = {
  applied: boolean;
  created: number;
  updated: number;
  problems: { row: number; message: string }[];
};

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
  await call('POST', '/api/actores', {
    payload: {
      ID_Actor: 'A-1',
      'Nombre_Actor/Organizacion': 'Comunidad Norte',
      Tipo_Actor: 'Comunal',
    },
  });
  return { t, admin, call };
};

const rows = [
  { ID_Actor: 'A-1', Influencia: 'Alta', Tipo_Actor: '  ' },
  { ID_Actor: 'A-2', 'Nombre_Actor/Organizacion': 'Frente Sur' },
  { 'Nombre_Actor/Organizacion': 'Gremio sin código' },
  { ID_Actor: '', 'Nombre_Actor/Organizacion': '' },
];

describe('POST /system/import/{module}', () => {
  it('previews, then merges in one audited transaction without erasing data', async () => {
    const { call } = await setup();
    const preview = await call('POST', '/system/import/actores', { rows, source: 'actores.csv' });
    expect(preview).toEqual({
      status: 200,
      body: { applied: false, created: 2, updated: 1, problems: [] },
    });
    expect(((await call('GET', '/api/actores')).body as unknown[]).length).toBe(1);

    const applied = await call('POST', '/system/import/actores', {
      rows,
      dry_run: false,
      source: 'actores.csv',
    });
    expect(applied.body).toEqual({ applied: true, created: 2, updated: 1, problems: [] });
    const a1 = (await call('GET', '/api/actores/A-1')).body;
    expect(a1).toEqual({
      ID_Actor: 'A-1',
      'Nombre_Actor/Organizacion': 'Comunidad Norte',
      Tipo_Actor: 'Comunal',
      Influencia: 'Alta',
      _id: 'A-1',
    });
    const list = (await call('GET', '/api/actores')).body as { _id: string }[];
    expect(list).toHaveLength(3);
    expect(list.some((r) => /^A-[0-9A-F]{8}$/.test(r._id))).toBe(true);
    const audit = (await call('GET', '/system/audit')).body as Record<string, unknown>[];
    expect(audit[0]).toMatchObject({
      action: 'IMPORT',
      module: 'Actores',
      detail: 'Importación de 3 filas desde actores.csv',
    });
    const history = (await call('GET', '/api/actores/A-1/history')).body as {
      operation: string;
    }[];
    expect(history.map((v) => v.operation)).toEqual(['UPDATE', 'CREATE']);
  });

  it('refuses the whole batch when any row has a problem', async () => {
    const { call } = await setup();
    const bad = [
      { ID_Actor: 'A-5', 'Nombre_Actor/Organizacion': 'Uno' },
      { ID_Actor: 'A-5', 'Nombre_Actor/Organizacion': 'Duplicado' },
      { ID_Actor: 'x'.repeat(201) },
    ];
    const res = await call('POST', '/system/import/actores', { rows: bad, dry_run: false });
    expect(res.status).toBe(422);
    expect((res.body as Report).problems).toEqual([
      { row: 2, message: 'El código A-5 ya aparece en la fila 1' },
      {
        row: 3,
        message: 'ID_Actor: ID_Actor must be a string or number of at most 200 characters',
      },
    ]);
    expect(((await call('GET', '/api/actores')).body as unknown[]).length).toBe(1);
  });

  it('is limited to writers and territorial modules', async () => {
    const { t, admin, call } = await setup();
    expect((await call('POST', '/system/import/usuarios', { rows: [] })).status).toBe(404);
    expect((await call('POST', '/system/import/planetas', { rows: [] })).status).toBe(404);
    expect((await call('POST', '/system/import/actores', { rows: 'x' })).status).toBe(422);
    await t.createAccount(admin.cookie, {
      username: 'reader',
      full_name: 'Reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await t.grant(admin.cookie, 'reader');
    const reader = await t.login('reader', 'reader-password-123');
    expect((await call('POST', '/system/import/actores', { rows }, reader.cookie)).status).toBe(
      403,
    );
  });
});
