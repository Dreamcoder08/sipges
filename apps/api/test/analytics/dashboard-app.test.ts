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
});
