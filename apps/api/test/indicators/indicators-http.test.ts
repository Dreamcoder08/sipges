import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type IrsaSnapshot,
  type ValidationTemplate,
  createIndicatorsService,
} from '../../src/contexts/indicators/application/index.ts';
import {
  DEFAULT_IRSA_CONFIG,
  type IndicatorsReport,
  type IrsaResult,
} from '../../src/contexts/indicators/domain/index.ts';
import { indicatorsRoutes } from '../../src/contexts/indicators/http/indicators-routes.ts';
import {
  createSqlIrsaConfigStore,
  createSqlIrsaSnapshotStore,
  createSqlModuleRecordReader,
} from '../../src/contexts/indicators/infrastructure/index.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createTestApp } from '../support/test-app.ts';

type Snapshot = IrsaResult & { ok: true; id: number };

const SECHURA = 'MASCLI/PRJ-SECHURA';
const NORTE = 'ACME/NORTE';

/** Mounts only the Indicators routes; the scope comes from a test header (synthetic tenants). */
const setup = async () => {
  const t = await createTestApp();
  await t.sql.exec(
    "INSERT INTO tenants (company_id, project_id, label) VALUES ('ACME', 'NORTE', 'Norte sintético')",
  );
  const indicators = createIndicatorsService({
    records: createSqlModuleRecordReader(t.sql),
    configs: createSqlIrsaConfigStore(t.sql),
    snapshots: createSqlIrsaSnapshotStore(t.sql),
    clock: t.clock,
  });
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      const [companyId = '', projectId = ''] = (c.req.header('x-test-scope') ?? SECHURA).split('/');
      c.set('scope', { companyId, projectId });
      await next();
    })
    .route('/', indicatorsRoutes({ indicators }));
  const request = (path: string, scope = SECHURA, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { 'x-test-scope': scope, 'content-type': 'application/json', ...init.headers },
    });
  const post = (path: string, body: unknown, scope = SECHURA) =>
    request(path, scope, { method: 'POST', body: JSON.stringify(body) });
  return { t, request, post };
};

const seedModuleRecords = async (t: Awaited<ReturnType<typeof createTestApp>>) =>
  t.sql.exec(`
    INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
      ('MASCLI/PRJ-SECHURA', 'Demandas', 'D-1', '{"Estado":"Abierta","Tema":"Empleo"}', now(), now()),
      ('MASCLI/PRJ-SECHURA', 'Demandas', 'D-2', '{"Estado":"Abierta","Tema":"Vías"}', now(), now()),
      ('ACME/NORTE', 'Demandas', 'D-9', '{"Estado":"Abierta","Tema":"Agua"}', now(), now());
  `);

const auditRows = (t: Awaited<ReturnType<typeof createTestApp>>) =>
  t.sql.query('SELECT tenant_id, module, record_id, action, detail FROM audit ORDER BY id');

describe('GET /system/irsa and /system/indicators', () => {
  it('computes an empty IRSA, not a 500, while module_records does not exist yet', async () => {
    const { t, request } = await setup();
    await t.sql.exec('DROP TABLE module_records CASCADE');
    const res = await request('/system/irsa');
    expect(res.status).toBe(200);
    const body = (await res.json()) as IrsaResult;
    expect(body).toMatchObject({
      irsa: 5.55,
      level: 'Verde',
      config_version: '0.4-indicators',
      status: 'PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS',
      weights: DEFAULT_IRSA_CONFIG.weights,
    });
    expect(body.drivers).toHaveLength(15);
    expect(body.indicators).toHaveLength(32);
    expect(Object.keys(body.thresholds)).toEqual(['Verde', 'Amarillo', 'Naranja', 'Rojo']);
  });

  it('reads only the request tenant module records', async () => {
    const { t, request } = await setup();
    await seedModuleRecords(t);
    const d1 = async (scope: string) => {
      const body = (await (await request('/system/indicators', scope)).json()) as IndicatorsReport;
      return body.indicators.find((x) => x.code === 'D1');
    };
    expect(await d1(SECHURA)).toMatchObject({ score: 14, evidence_count: 2 });
    expect(await d1(NORTE)).toMatchObject({ score: 7, evidence_count: 1 });
  });
});

describe('/system/irsa/config', () => {
  it('defaults per tenant, rejects unbalanced weights and persists valid patches per tenant', async () => {
    const { t, request, post } = await setup();
    expect(await (await request('/system/irsa/config')).json()).toEqual(DEFAULT_IRSA_CONFIG);

    const bad = await post('/system/irsa/config', { payload: { weights: { G: 0.5 } } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ detail: 'Los pesos deben sumar aproximadamente 1.' });

    const weights = { G: 0.5, A: 0.5, D: 0, N: 0, E: 0, I: 0 };
    const ok = await post('/system/irsa/config', {
      payload: { weights, thresholds: { Bajo: [0, 100] } },
    });
    expect(ok.status).toBe(200);
    const saved = (await ok.json()) as { config: unknown };
    expect(saved).toEqual({
      ok: true,
      config: { ...DEFAULT_IRSA_CONFIG, weights, thresholds: { Bajo: [0, 100] } },
    });
    expect(await (await request('/system/irsa/config')).json()).toEqual(saved.config);
    expect(((await (await request('/system/irsa')).json()) as IrsaResult).level).toBe('Bajo');
    expect(await (await request('/system/irsa/config', NORTE)).json()).toEqual(DEFAULT_IRSA_CONFIG);
    // Only the accepted update is audited (app.py writes audit after a successful save).
    expect(await auditRows(t)).toEqual([
      {
        tenant_id: SECHURA,
        module: 'IRSA',
        record_id: null,
        action: 'CONFIG_UPDATE',
        detail: 'Parámetros IRSA actualizados',
      },
    ]);
  });

  it('answers 422 for a body without payload or with non-numeric weights', async () => {
    const { post } = await setup();
    expect((await post('/system/irsa/config', {})).status).toBe(422);
    expect(
      (await post('/system/irsa/config', { payload: { weights: { G: 'mucho' } } })).status,
    ).toBe(422);
  });
});

describe('IRSA snapshots', () => {
  it('saves a snapshot and lists history newest first, scoped to the tenant', async () => {
    const { t, request, post } = await setup();
    const first = await post('/system/irsa/snapshot', { payload: { note: 'Corte 1' } });
    expect(first.status).toBe(200);
    const snap = (await first.json()) as Snapshot;
    expect(snap).toMatchObject({ ok: true, id: expect.any(Number), irsa: 5.55, level: 'Verde' });
    t.clock.advance(60);
    const second = (await (
      await post('/system/irsa/snapshot', { payload: {} })
    ).json()) as Snapshot;

    const history = (await (await request('/system/irsa/history')).json()) as IrsaSnapshot[];
    expect(history).toEqual([
      {
        id: second.id,
        ts: '2026-10-12T12:01:00Z',
        irsa: 5.55,
        level: 'Verde',
        scores: second.scores,
        config_version: '0.4-indicators',
        note: '',
      },
      {
        id: snap.id,
        ts: '2026-10-12T12:00:00Z',
        irsa: 5.55,
        level: 'Verde',
        scores: snap.scores,
        config_version: '0.4-indicators',
        note: 'Corte 1',
      },
    ]);
    expect(Object.keys(history[0]?.scores ?? {})).toEqual(['G', 'A', 'D', 'N', 'E', 'I']);
    expect(await (await request('/system/irsa/history?limit=1')).json()).toHaveLength(1);
    expect(await (await request('/system/irsa/history', NORTE)).json()).toEqual([]);
    expect(await auditRows(t)).toEqual([
      {
        tenant_id: SECHURA,
        module: 'IRSA',
        record_id: String(snap.id),
        action: 'SNAPSHOT',
        detail: 'Corte IRSA guardado: 5.55 Verde',
      },
      {
        tenant_id: SECHURA,
        module: 'IRSA',
        record_id: String(second.id),
        action: 'SNAPSHOT',
        detail: 'Corte IRSA guardado: 5.55 Verde',
      },
    ]);
  });

  it('rejects a non-integer limit with 422', async () => {
    const { request } = await setup();
    expect((await request('/system/irsa/history?limit=abc')).status).toBe(422);
  });
});

describe('static system documents', () => {
  it('serves model status and the 32-row validation template', async () => {
    const { request } = await setup();
    const status = await (await request('/system/model-status')).json();
    expect(status).toMatchObject({
      indicator_count: 32,
      dimensions: ['G', 'A', 'D', 'N', 'E', 'I'],
    });
    const template = (await (
      await request('/system/validation-template')
    ).json()) as ValidationTemplate;
    expect(template.status).toBe('PENDIENTE');
    expect(template.rows).toHaveLength(32);
    expect(template.rows[0]).toEqual({
      dimension: 'G',
      code: 'G1',
      name: expect.any(String),
      definition: expect.any(String),
      expert_1: null,
      expert_2: null,
      expert_3: null,
      expert_4: null,
      expert_5: null,
      aiken_v: null,
      decision: 'Pendiente',
    });
  });
});
