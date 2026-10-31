import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

it('preserves raw legacy dashboard values and full sibling analytics over HTTP', async () => {
  const t = await createTestApp();
  const { cookie } = await t.login('admin', 'admin-password-123');
  const seed = async (module: string, id: string, payload: Record<string, unknown>) =>
    t.sql.query(
      `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
      ['MASCLI/PRJ-SECHURA', module, id, JSON.stringify(payload), '2026-01-01T00:00:00Z'],
    );
  for (const [index, value] of [undefined, null, false, 0, '', [], {}].entries()) {
    await seed('Alertas', `fallback-${index}`, { Nivel_Preliminar: value, Nivel: 'Verde' });
  }
  for (const [id, payload] of Object.entries({
    bool: { Nivel_Preliminar: true, Nivel: 'ignored', Estado: ' CERRADA ' },
    number: { Nivel_Preliminar: 3, Estado: 'DESCARTADO' },
    array: { Nivel_Preliminar: ['Rojo'], Estado: 'cerrado' },
    object: { Nivel_Preliminar: { raw: true }, Estado: 'descartada' },
    none: {},
    null: { Nivel_Preliminar: null, Nivel: null, Estado: null },
    false: { Nivel: false, Estado: false },
  }))
    await seed('Alertas', id, payload);
  for (const [index, Estado] of [' Cerrada ', 'CERRADO', null, false, 0, {}, []].entries()) {
    await seed('Demandas', `d${index}`, { Estado });
  }
  await seed('Eventos', 'e1', { Territorio: 'Territorio sintético', Extra: 'x'.repeat(4096) });
  for (const module of ['Actores', 'Directorio_Territorial', 'Actores_Priorizados']) {
    await seed(module, 'one', { Extra: 'x'.repeat(4096) });
  }
  const response = await t.request('/api/dashboard', { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    eventos: 1,
    actores: 1,
    demandas_abiertas: 5,
    alertas_activas: 10,
    directorio: 1,
    priorizados: 1,
    niveles: { Verde: 7, True: 1, '3': 1, '["Rojo"]': 1, '{"raw":true}': 1, 'Sin nivel': 3 },
  });
  const sibling = await t.request('/system/situational-analysis', { headers: { cookie } });
  expect(sibling.status).toBe(200);
  expect(await sibling.json()).toMatchObject({
    counts: { eventos: 1 },
    territorios: [['Territorio sintético', 1]],
  });
});

it('retains clearance and tenant isolation, and rejected scope leaves records and counts unchanged', async () => {
  const t = await createTestApp();
  const admin = await t.login('admin', 'admin-password-123');
  const call = (path: string, cookie = admin.cookie, method = 'GET', body?: unknown) =>
    t.request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect(
    (await call('/api/eventos', admin.cookie, 'POST', { payload: { ID_Evento: 'secret' } })).status,
  ).toBe(200);
  expect(
    (
      await call('/system/marking', admin.cookie, 'PUT', {
        module: 'eventos',
        id: 'secret',
        marking: 'restringido',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await t.createScope(admin.cookie, {
        company_id: 'ACME',
        project_id: 'NORTE',
        label: 'Synthetic North',
        username: 'admin',
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await t.request('/api/eventos', {
        method: 'POST',
        headers: {
          cookie: admin.cookie,
          'content-type': 'application/json',
          'x-mascli-scope': 'ACME/NORTE',
        },
        body: JSON.stringify({ payload: { ID_Evento: 'foreign' } }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call('/system/auth/grants', admin.cookie, 'DELETE', {
        username: 'admin',
        company_id: 'ACME',
        project_id: 'NORTE',
      })
    ).status,
  ).toBe(200);
  for (const role of ['consulta', 'analista', 'coordinador']) {
    expect(
      (
        await t.createAccount(admin.cookie, {
          username: role,
          full_name: role,
          password: `${role}-password-123`,
          role,
        })
      ).status,
    ).toBe(200);
    await t.grant(admin.cookie, role);
    const { cookie } = await t.login(role, `${role}-password-123`);
    const before = await call('/api/dashboard', cookie);
    expect(before.status).toBe(200);
    const summary = await before.json();
    expect(summary).toMatchObject({ eventos: role === 'consulta' ? 0 : 1 });
    const records = await call('/api/eventos', cookie);
    expect(records.status).toBe(200);
    const stored = await records.json();
    expect(stored).toHaveLength(role === 'consulta' ? 0 : 1);
    expect((await call('/api/eventos/foreign', cookie)).status).toBe(404);
    const rejected = await call('/api/dashboard?project_id=NORTE', cookie);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ detail: 'Proyecto fuera de alcance' });
    expect(await (await call('/api/dashboard', cookie)).json()).toEqual(summary);
    expect(await (await call('/api/eventos', cookie)).json()).toEqual(stored);
  }
});

describe('GET /api/dashboard in the composed app', () => {
  it('is not taken for a generic module and counts tenant records', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login('admin', 'admin-password-123');
    const post = (module: string, payload: Record<string, unknown>) =>
      t.request(`/api/${module}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ payload }),
      });
    expect((await post('eventos', { Titulo: 'Asamblea' })).status).toBe(200);
    expect((await post('alertas', { Estado: 'Abierta', Nivel: 'Naranja' })).status).toBe(200);
    const res = await t.request('/api/dashboard', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      eventos: 1,
      alertas_activas: 1,
      niveles: { Naranja: 1 },
    });
  });

  it('follows record changes live', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login('admin', 'admin-password-123');
    const request = (method: string, path: string, payload?: Record<string, unknown>) =>
      t.request(path, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        ...(payload ? { body: JSON.stringify({ payload }) } : {}),
      });
    await request('POST', '/api/eventos', { ID_Evento: 'EV-01' });
    await request('POST', '/api/demandas', { ID_Demanda: 'D-REAL', Estado: 'En diálogo' });
    const summary = async () =>
      (await (await request('GET', '/api/dashboard')).json()) as {
        eventos: number;
        demandas_abiertas: number;
      };
    expect(await summary()).toMatchObject({ eventos: 1, demandas_abiertas: 1 });
    await request('PUT', '/api/demandas/D-REAL', { ID_Demanda: 'D-REAL', Estado: 'Cerrada' });
    expect((await summary()).demandas_abiertas).toBe(0);
  });
});

it('normalizes closed alert states consistently with the charts', async () => {
  const t = await createTestApp();
  const { cookie } = await t.login('admin', 'admin-password-123');
  for (const Estado of [' Cerrada ', 'Cerrado', ' DESCARTADO ']) {
    const response = await t.request('/api/alertas', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { Estado } }),
    });
    expect(response.status).toBe(200);
  }
  const summary = await t.request('/api/dashboard', { headers: { cookie } });
  expect(await summary.json()).toMatchObject({ alertas_activas: 0 });
});
