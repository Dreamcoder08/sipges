import { describe, expect, it } from 'vitest';
import { dayBound } from '../../src/contexts/ontology/application/ontology-service.ts';
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
  const create = (module: string, payload: Json) => call('POST', `/api/${module}`, { payload });
  await create('eventos', {
    ID_Evento: 'EV-1',
    Descripcion_Hecho: 'Asamblea',
    Fecha: '2026-09-15',
  });
  await create('eventos', {
    ID_Evento: 'EV-2',
    Descripcion_Hecho: 'Paro',
    Fecha: '2026-10-02T08:00',
  });
  await create('eventos', { ID_Evento: 'EV-3', Descripcion_Hecho: 'Sin fecha', Fecha: 'pronto' });
  await create('demandas', {
    ID_Demanda: 'D-1',
    Descripcion: 'Agua',
    Fecha_Registro: '2026-10-02',
  });
  await create('alertas', { ID_Alerta: 'AL-1', Causa: 'Bloqueo', Fecha: '2025-12-31' });
  await create('actores', { ID_Actor: 'A-1', 'Nombre_Actor/Organizacion': 'Sin fecha propia' });
  return { t, admin, call };
};

const entries = (body: Json) =>
  (body['entries'] as Json[]).map((e) => `${e['date']} ${e['module']}/${e['id']}`);

describe('GET /system/timeline', () => {
  it('lists dated records of every type newest first, within the range', async () => {
    const { call } = await setup();
    const all = await call('GET', '/system/timeline');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ from: '0000-01-01', to: '9999-12-31', truncated: false });
    expect(entries(all.body)).toEqual([
      '2026-10-02 demandas/D-1',
      '2026-10-02 eventos/EV-2',
      '2026-09-15 eventos/EV-1',
      '2025-12-31 alertas/AL-1',
    ]);
    const october = await call('GET', '/system/timeline?from=2026-10&to=2026-10&modules=eventos');
    expect(entries(october.body)).toEqual(['2026-10-02 eventos/EV-2']);
    expect(october.body).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    const limited = await call('GET', '/system/timeline?from=2026&limit=2');
    expect(entries(limited.body)).toHaveLength(2);
    expect(limited.body['truncated']).toBe(true);
    expect((await call('GET', '/system/timeline?from=ayer')).status).toBe(422);
    expect(entries((await call('GET', '/system/timeline?modules=actores')).body)).toEqual([]);
  });

  it('hides restricted records from read-only roles', async () => {
    const { t, admin, call } = await setup();
    await call('PUT', '/system/marking', { module: 'eventos', id: 'EV-1', marking: 'restringido' });
    await t.createAccount(admin.cookie, {
      username: 'reader',
      full_name: 'reader',
      password: 'reader-password-123',
      role: 'consulta',
    });
    await t.grant(admin.cookie, 'reader');
    const reader = (await t.login('reader', 'reader-password-123')).cookie;
    const seen = await call('GET', '/system/timeline?modules=eventos', undefined, reader);
    expect(entries(seen.body)).toEqual(['2026-10-02 eventos/EV-2']);
  });

  it('expands partial bounds', () => {
    expect(dayBound('2026', false)).toBe('2026-01-01');
    expect(dayBound('2026-02', true)).toBe('2026-02-31');
    expect(dayBound('2026-13', false)).toBeNull();
    expect(dayBound('', true)).toBe('9999-12-31');
  });
});
