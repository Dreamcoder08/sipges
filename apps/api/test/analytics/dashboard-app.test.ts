import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

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
