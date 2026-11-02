import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { ConflictRiskResponse } from '../../../../packages/contracts/src/analytics.ts';
import {
  type ConflictRiskSources,
  type RiskRecord,
  createConflictRiskService,
} from '../../src/contexts/analytics/application/index.ts';
import { conflictRiskRoutes } from '../../src/contexts/analytics/http/conflict-risk-routes.ts';
import type { Scope } from '../../src/contexts/tenancy/application/index.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createTestApp } from '../support/test-app.ts';

// Synthetic tenants: each source answers only for the scope it is asked about.
const SECHURA = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };
const NORTE = { companyId: 'ACME', projectId: 'NORTE' };
const key = (s: Scope) => `${s.companyId}/${s.projectId}`;

const RECORDS: Record<string, RiskRecord[]> = {
  'SIPGES/PRJ-SECHURA': [
    {
      module: 'Demandas',
      id: 'd1',
      payload: { Territorio: 'Pampa Alta', Fecha_Registro: '2026-10-20', Estado: 'Nueva' },
      updatedAt: '2026-10-20T10:00:00.000Z',
    },
  ],
  'ACME/NORTE': [
    {
      module: 'Alertas',
      id: 'n1',
      payload: { Territorio: 'Cerro Norte', Fecha: '2026-10-30', Nivel_Preliminar: 'Rojo' },
      updatedAt: '2026-10-30T10:00:00.000Z',
    },
  ],
};

const setup = (scope: Scope) => {
  const asked: string[] = [];
  const sources: ConflictRiskSources = {
    async records(s, modules) {
      asked.push(`records:${key(s)}:${[...modules].sort().join(',')}`);
      return RECORDS[key(s)] ?? [];
    },
    async alerts(s) {
      asked.push(`alerts:${key(s)}`);
      return key(s) === 'ACME/NORTE'
        ? [
            {
              id: 'ta1',
              createdAt: '2026-10-31T09:00:00.000Z',
              territory: 'Cerro Norte',
              level: 'Alta',
              status: 'Pendiente de verificación',
              reviewedAt: null,
            },
          ]
        : [];
    },
    async irsa(s) {
      asked.push(`irsa:${key(s)}`);
      return [];
    },
  };
  const service = createConflictRiskService({
    sources,
    clock: { now: () => new Date('2026-11-02T15:00:00Z') },
  });
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set('scope', scope);
      await next();
    })
    .route('/', conflictRiskRoutes({ conflictRisk: service }));
  return { app, asked };
};

const get = async (scope: Scope) => {
  const { app, asked } = setup(scope);
  const response = await app.request('/system/conflict-risk');
  expect(response.status).toBe(200);
  return { body: ConflictRiskResponse.parse(await response.json()), asked };
};

describe('GET /system/conflict-risk', () => {
  it('ranks the scope localities with factors, confidence and the back-test', async () => {
    const { body, asked } = await get(SECHURA);
    expect(body.generatedOn).toBe('2026-11-02');
    expect(body.status).toBe('ok');
    expect(body.localities.map((l) => l.name)).toEqual(['Pampa Alta']);
    expect(body.localities[0]?.factors[0]?.records[0]).toMatchObject({
      module: 'Demandas',
      id: 'd1',
    });
    expect(body.localities[0]?.confidence).toBe('baja');
    expect(body.localities[0]?.confidenceReason).toBe(
      'Historial insuficiente para calibrar; el detalle está en el back-test.',
    );
    expect(body.backtest['30'].calibrated).toBe(false);
    expect(asked).toEqual([
      'records:SIPGES/PRJ-SECHURA:Alertas,Compromisos,Demandas,Eventos,Narrativas',
      'alerts:SIPGES/PRJ-SECHURA',
      'irsa:SIPGES/PRJ-SECHURA',
    ]);
  });

  it('never shows another tenant: each project sees only its own localities', async () => {
    const sechura = await get(SECHURA);
    const norte = await get(NORTE);
    const names = (b: typeof sechura.body) => [...b.localities, ...b.actors].map((u) => u.name);
    expect(names(sechura.body)).not.toContain('Cerro Norte');
    expect(names(norte.body)).toEqual(['Cerro Norte']);
    expect(norte.asked.every((a) => a.includes('ACME/NORTE'))).toBe(true);
    expect(JSON.stringify(norte.body)).not.toContain('d1');
  });

  it('answers «sin datos suficientes» for a project without records', async () => {
    const { body } = await get({ companyId: 'VACIO', projectId: 'NADA' });
    expect(body.status).toBe('sin datos suficientes');
    expect(body.localities).toEqual([]);
    expect(body.backtest['90'].reason).toMatch(/Historial insuficiente/);
  });

  it('reads through the real app under the tenant RLS and never mixes projects', async () => {
    const t = await createTestApp();
    const { cookie } = await t.login('admin', 'admin-password-123');
    await t.sql.query(
      "INSERT INTO tenants (company_id, project_id, label) VALUES ('ACME', 'NORTE', 'Norte sintético')",
    );
    const seed = (tenant: string, module: string, id: string, payload: Record<string, unknown>) =>
      t.sql.query(
        `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
        [tenant, module, id, JSON.stringify(payload), '2026-10-01T00:00:00Z'],
      );
    await seed('SIPGES/PRJ-SECHURA', 'Demandas', 'd-own', {
      Territorio: 'Pampa Alta',
      Fecha_Registro: '2026-10-01',
      Estado: 'Nueva',
    });
    await seed('ACME/NORTE', 'Alertas', 'a-other', {
      Territorio: 'Cerro Norte',
      Fecha: '2026-10-05',
      Nivel_Preliminar: 'Rojo',
    });
    const response = await t.request('/system/conflict-risk', { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = ConflictRiskResponse.parse(await response.json());
    expect(body.generatedOn).toBe('2026-10-12');
    expect(body.localities.map((l) => l.name)).toEqual(['Pampa Alta']);
    expect(JSON.stringify(body)).not.toContain('a-other');
    const foreign = await t.request('/system/conflict-risk?project_id=NORTE', {
      headers: { cookie },
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ detail: 'Proyecto fuera de alcance' });
  });
});
