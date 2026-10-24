import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { BENCHMARK_HTTP_PATHS, createBenchmarkSession } from '../../bench/http-session.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';

it('the real benchmark session reaches every declared HTTP scenario with existing permissions', async () => {
  const db = new PGlite();
  try {
    const sql = pgliteClient(db);
    await migrate(sql, await loadMigrations());
    const session = await createBenchmarkSession(sql, {
      model: 'offline-benchmark-test',
      embed: async () => {
        throw new Error('Unexpected model call');
      },
    });
    const headers = { host: 'localhost', cookie: session.cookie };
    const created = await session.app.request('/api/eventos', {
      method: 'POST',
      headers: { ...headers, origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { ID_Evento: 'EV-BENCH', Titulo: 'Synthetic benchmark' } }),
    });
    expect(created.status).toBe(200);
    const dashboard = async () => {
      const response = await session.app.request('/api/dashboard', { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await dashboard();
    expect(before).toMatchObject({ eventos: 1 });
    for (const path of BENCHMARK_HTTP_PATHS) {
      const response = await session.app.request(path, { headers });
      expect(response.status, `${path}: ${await response.text()}`).toBe(200);
      await expect(session.get(path)).resolves.toBeUndefined();
    }
    const scope = await session.app.request('/system/auth/current-scope', { headers });
    expect(scope.status).toBe(200);
    expect(await scope.json()).toEqual({
      company_id: 'MASCLI',
      project_id: 'PRJ-SECHURA',
      scope: 'MASCLI/PRJ-SECHURA',
    });
    // The fixture enrolls MFA rather than disabling the middleware for benchmarks.
    const setup = await session.app.request('/system/auth/totp/setup', {
      method: 'POST',
      headers: { ...headers, origin: 'http://localhost' },
    });
    expect(setup.status).toBe(409);
    expect(await setup.json()).toEqual({
      detail: 'MFA ya está activado; no se permite reiniciar la configuración',
    });
    const anonymous = await session.app.request('/api/dashboard', {
      headers: { host: 'localhost' },
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ detail: 'Inicie sesión para acceder a MASCLI' });
    const forbidden = await session.app.request('/api/dashboard?project_id=PRJ-OTHER', { headers });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ detail: 'Proyecto fuera de alcance' });
    await expect(session.get('/api/dashboard?project_id=PRJ-OTHER')).rejects.toThrow(
      '/api/dashboard?project_id=PRJ-OTHER answered 403',
    );
    await expect(session.get('/missing-benchmark-route')).rejects.toThrow(
      '/missing-benchmark-route answered 404',
    );
    expect(await dashboard()).toEqual(before);
  } finally {
    await db.close();
  }
});
