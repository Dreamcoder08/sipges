import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  ConsensusEngineResponse,
  IntegratedAnalysisResponse,
  SituationalAnalysisResponse,
  StrategicAssessmentResponse,
} from '../../../../packages/contracts/src/analytics.ts';
import {
  type AnalyticsRecordReader,
  createAnalyticsService,
} from '../../src/contexts/analytics/application/index.ts';
import { analyticsRoutes } from '../../src/contexts/analytics/http/analytics-routes.ts';
import type { StoredRecord } from '../../src/contexts/analytics/domain/records.ts';
import type { Scope } from '../../src/contexts/tenancy/application/index.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';

const DATA: Record<string, Record<string, StoredRecord[]>> = {
  'MASCLI/PRJ-SECHURA': {
    Eventos: [{ id: 'e1', payload: { Territorio: 'Sechura' } }],
    Alertas: [{ id: 'a1', payload: { Estado: 'Abierta', Nivel_Preliminar: 'Rojo' } }],
    Hechos_Compartidos: [{ id: 'h1', payload: { Asunto: 'agua potable' } }],
    Dialogos: [{ id: 'd1', payload: { Tema: 'Agua potable', Proyecto_ID: 'PRJ-SECHURA' } }],
  },
  'ACME/NORTE': {
    Hechos_Compartidos: [{ id: 'n1', payload: { Proyecto_ID: 'NORTE' } }],
  },
};

const setup = (scope: Scope) => {
  const requested: string[][] = [];
  const reader: AnalyticsRecordReader = {
    async read(s, modules) {
      requested.push([...modules]);
      const all = DATA[`${s.companyId}/${s.projectId}`] ?? {};
      return Object.fromEntries(modules.map((m) => [m, all[m] ?? []]));
    },
  };
  const analytics = createAnalyticsService({
    reader,
    clock: { now: () => new Date('2026-10-12T12:00:00.123Z') },
  });
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set('scope', scope);
      await next();
    })
    .route('/', analyticsRoutes({ analytics }));
  return { app, requested };
};

const SECHURA = { companyId: 'MASCLI', projectId: 'PRJ-SECHURA' };

describe('analytics HTTP routes', () => {
  it('GET /system/situational-analysis uses the scope project and matches the contract', async () => {
    const { app } = setup(SECHURA);
    const res = await app.request('/system/situational-analysis?project_id=PRJ-SECHURA');
    expect(res.status).toBe(200);
    const body = SituationalAnalysisResponse.parse(await res.json());
    expect(body.project_id).toBe('PRJ-SECHURA');
    expect(body.generated_at).toBe('2026-10-12T12:00:00Z');
    expect(body.counts.eventos).toBe(1);
    expect(body.alertas_activas).toBe(1);
    expect(body.territorios).toEqual([['Sechura', 1]]);
  });

  it('GET /system/strategic-assessment', async () => {
    const { app } = setup(SECHURA);
    const body = StrategicAssessmentResponse.parse(
      await (await app.request('/system/strategic-assessment')).json(),
    );
    expect(body.facts_pending).toBe(1);
    expect(body.dialogues_open).toBe(1);
  });

  it('GET /system/consensus-engine', async () => {
    const { app } = setup(SECHURA);
    const body = ConsensusEngineResponse.parse(
      await (await app.request('/system/consensus-engine')).json(),
    );
    expect(body.summary.total).toBe(body.recommendations.length);
    expect(body.recommendations.map((c) => c.origen)).toContain('hechos+dialogos');
  });

  it('GET /system/integrated-analysis composes links and plan', async () => {
    const { app } = setup(SECHURA);
    const body = IntegratedAnalysisResponse.parse(
      await (await app.request('/system/integrated-analysis')).json(),
    );
    expect(body.candidate_links.map((l) => l.origen)).toEqual(['hechos/h1']);
    expect(body.summary.acciones_sugeridas).toBe(body.action_plan.length);
    expect(body.summary.registros_estrategicos).toBe(2);
  });

  it('a non-default tenant drops records whose Proyecto_ID falls back to PRJ-SECHURA', async () => {
    const { app } = setup({ companyId: 'ACME', projectId: 'NORTE' });
    const body = StrategicAssessmentResponse.parse(
      await (await app.request('/system/strategic-assessment')).json(),
    );
    expect(body.project_id).toBe('NORTE');
    expect(body.counts.hechos).toBe(1);
  });
});
