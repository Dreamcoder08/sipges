import { ProjectSettings, SituationsReport } from '@mascli/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createSituationsService } from '../../src/contexts/situations/application/index.ts';
import { DEFAULT_SETTINGS, levelText } from '../../src/contexts/situations/domain/settings.ts';
import { situationsRoutes } from '../../src/contexts/situations/http/situations-routes.ts';
import { createSqlProjectSettingsStore } from '../../src/contexts/situations/infrastructure/sql-project-settings-store.ts';
import { createSqlSituationRecordReader } from '../../src/contexts/situations/infrastructure/sql-situation-record-reader.ts';
import { checkRoleAccess } from '../../src/contexts/identity/domain/access-policy.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createTestApp } from '../support/test-app.ts';

const SECHURA = 'MASCLI/PRJ-SECHURA';
const NORTE = 'ACME/NORTE';

const setup = async () => {
  const t = await createTestApp();
  await t.sql.exec(
    "INSERT INTO tenants (company_id, project_id, label) VALUES ('ACME', 'NORTE', 'Norte sintético')",
  );
  const situations = createSituationsService({
    settings: createSqlProjectSettingsStore(t.sql),
    records: createSqlSituationRecordReader(t.sql),
    clock: t.clock,
  });
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      const [companyId = '', projectId = ''] = (c.req.header('x-test-scope') ?? SECHURA).split('/');
      c.set('scope', { companyId, projectId });
      c.set('identity', { username: 'admin', fullName: 'Admin', role: 'admin' });
      await next();
    })
    .route('/', situationsRoutes(situations));
  const request = (path: string, scope = SECHURA, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'x-test-scope': scope, 'content-type': 'application/json', ...init.headers },
    });
  const put = (body: unknown, scope = SECHURA) =>
    request('/system/v4/settings', scope, { method: 'PUT', body: JSON.stringify(body) });
  return { t, request, put };
};

describe('MASCLI 4.0 project settings', () => {
  it('starts with the preliminary colour meanings and no version switch', async () => {
    const { request } = await setup();
    const res = await request('/system/v4/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      level_meanings: {
        Verde: 'Situación estable / riesgo bajo',
        Amarillo: 'Requiere atención y seguimiento',
        Naranja: 'Requiere intervención preventiva',
        Rojo: 'Situación crítica / atención inmediata',
      },
      window_days: 90,
      half_life_days: 14,
      thresholds: { Amarillo: 2, Naranja: 4, Rojo: 7 },
      recommendations: expect.arrayContaining([
        {
          id: 'reunion',
          condition: 'Nivel Naranja o Rojo',
          text: 'Coordinar una reunión con los actores involucrados.',
          custom: false,
        },
      ]),
      phase: null,
      phases: expect.arrayContaining([
        {
          id: 'operacion',
          label: 'Operación',
          weights: null,
          suggestion: { G: 0.15, A: 0.15, D: 0.2, N: 0.15, E: 0.25, I: 0.1 },
        },
      ]),
      updated_by: '',
      updated_at: null,
    });
    expect(levelText(DEFAULT_SETTINGS, 'Naranja')).toBe(
      'Naranja – Requiere intervención preventiva',
    );
  });

  it('saves a change for one project only and audits it', async () => {
    const { t, request, put } = await setup();
    const res = await put({
      level_meanings: { ...DEFAULT_SETTINGS.levelMeanings, Rojo: 'Atención inmediata' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      level_meanings: { Rojo: 'Atención inmediata', Verde: 'Situación estable / riesgo bajo' },
      updated_by: 'admin',
    });
    expect(await (await request('/system/v4/settings')).json()).toMatchObject({
      level_meanings: { Rojo: 'Atención inmediata' },
    });
    expect(await (await request('/system/v4/settings', NORTE)).json()).toMatchObject({
      level_meanings: { Rojo: 'Situación crítica / atención inmediata' },
    });
    expect(
      await t.sql.query(
        "SELECT tenant_id, module, action, detail FROM audit WHERE module = 'MASCLI 4.0'",
      ),
    ).toEqual([
      {
        tenant_id: SECHURA,
        module: 'MASCLI 4.0',
        action: 'CONFIG_UPDATE',
        detail: 'Campos: levelMeanings',
      },
    ]);
  });

  it.each([false, true])(
    'ignores a stored version4 = %s key from earlier releases and does not echo it',
    async (stored) => {
      const { t, request, put } = await setup();
      await t.sql.exec(
        `INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
       VALUES ('${SECHURA}', '{"version4": ${stored}, "windowDays": 30}'::jsonb, 'legacy', now())`,
      );
      const read = await (await request('/system/v4/settings')).json();
      expect(read).toMatchObject({ window_days: 30, updated_by: 'legacy' });
      expect(read).not.toHaveProperty('version4');
      const saved = await (await put({ half_life_days: 10 })).json();
      expect(saved).toMatchObject({ window_days: 30, half_life_days: 10 });
      expect(saved).not.toHaveProperty('version4');
      expect((await put({ version4: !stored })).status).toBe(200);
      expect(await (await request('/system/v4/settings')).json()).not.toHaveProperty('version4');
    },
  );

  it('keeps the project wording of a recommendation and uses it in situations', async () => {
    const { t, request, put } = await setup();
    const res = await put({ recommendations: { reunion: 'Convocar mesa de diálogo.' } });
    expect(ProjectSettings.parse(await res.json()).recommendations).toContainEqual({
      id: 'reunion',
      condition: 'Nivel Naranja o Rojo',
      text: 'Convocar mesa de diálogo.',
      custom: true,
    });
    expect((await put({ recommendations: { otra: 'x' } })).status).toBe(422);
    await t.sql.exec(`
      INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
        ('MASCLI/PRJ-SECHURA', 'Demandas', 'D-1',
          '{"Fecha_Registro":"2026-10-11","Tema":"Empleo local","Actor/Grupo":"Comunidad Norte","Prioridad":"Alta"}', now(), now()),
        ('MASCLI/PRJ-SECHURA', 'Narrativas', 'N-1',
          '{"Fecha_Inicio":"2026-10-09","Tema":"Trabajo","Actor_Relacionado":"Frente de Defensa"}', now(), now()),
        ('MASCLI/PRJ-SECHURA', 'Eventos', 'EV-1',
          '{"Fecha":"2026-10-07","Descripcion_Hecho":"Reunión sobre empleo","Actor_Principal":"Comunidad Norte"}', now(), now()),
        ('MASCLI/PRJ-SECHURA', 'Eventos', 'EV-2', '{"Descripcion_Hecho":"Sin fecha"}', now(), now()),
        ('ACME/NORTE', 'Demandas', 'D-9', '{"Fecha_Registro":"2026-10-11","Tema":"Empleo"}', now(), now()),
        ('ACME/NORTE', 'Demandas', 'D-8', '{"Fecha_Registro":"2026-10-10","Tema":"Empleo"}', now(), now());
    `);
    const report = SituationsReport.parse(await (await request('/system/v4/situations')).json());
    expect(report).toMatchObject({
      today: '2026-10-12',
      window_days: 90,
      considered: 3,
      undated: 1,
    });
    const employment = report.situations.find((s) => s.key === 'tema:empleo local');
    expect(employment).toMatchObject({
      level: 'Naranja',
      trend: 'en aumento',
      last_date: '2026-10-11',
    });
    expect(employment?.recommendations[0]).toBe('Convocar mesa de diálogo.');
    expect(employment?.records.map((r) => r.id)).toEqual(['D-1', 'N-1', 'EV-1']);
    const norte = SituationsReport.parse(
      await (await request('/system/v4/situations', NORTE)).json(),
    );
    expect(norte.situations.flatMap((s) => s.records.map((r) => r.id))).toEqual(['D-9', 'D-8']);
  });

  it('writes nothing when nothing changes', async () => {
    const { t, put } = await setup();
    expect((await put({})).status).toBe(200);
    expect(await t.sql.query('SELECT tenant_id FROM project_settings')).toEqual([]);
  });

  it('rejects empty meanings and thresholds out of order', async () => {
    const { put } = await setup();
    expect(
      (await put({ level_meanings: { ...DEFAULT_SETTINGS.levelMeanings, Verde: ' ' } })).status,
    ).toBe(422);
    expect((await put({ thresholds: { Amarillo: 3, Naranja: 2, Rojo: 5 } })).status).toBe(422);
    expect((await put({ window_days: 3 })).status).toBe(422);
  });

  it('lets every role read the settings but only an administrator change them', () => {
    expect(checkRoleAccess('consulta', 'GET', '/system/v4/settings').allowed).toBe(true);
    for (const role of ['analista', 'coordinador', 'consulta'] as const) {
      expect(checkRoleAccess(role, 'PUT', '/system/v4/settings')).toEqual({
        allowed: false,
        detail: 'Requiere rol administrador',
      });
    }
    expect(checkRoleAccess('admin', 'PUT', '/system/v4/settings').allowed).toBe(true);
  });
});
