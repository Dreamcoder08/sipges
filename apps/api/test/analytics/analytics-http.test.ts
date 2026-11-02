import { strFromU8, unzipSync } from 'fflate';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  ConsensusEngineResponse,
  DashboardResponse,
  IntegratedAnalysisResponse,
  SituationalAnalysisResponse,
  StrategicAssessmentResponse,
} from '../../../../packages/contracts/src/analytics.ts';
import {
  type AnalyticsRecordReader,
  createAnalyticsService,
} from '../../src/contexts/analytics/application/index.ts';
import { analyticsRoutes } from '../../src/contexts/analytics/http/analytics-routes.ts';
import { docxRenderer } from '../../src/contexts/documents/infrastructure/index.ts';
import type { StoredRecord } from '../../src/contexts/analytics/domain/records.ts';
import type { Scope } from '../../src/contexts/tenancy/application/index.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';

const DATA: Record<string, Record<string, StoredRecord[]>> = {
  'SIPGES/PRJ-SECHURA': {
    Eventos: [{ id: 'e1', payload: { Territorio: 'Sechura' } }],
    Alertas: [
      { id: 'a1', payload: { Estado: 'Abierta', Nivel_Preliminar: 'Rojo' } },
      { id: 'a2', payload: { Estado: 'Descartada', Nivel: 'Verde' } },
      { id: 'a3', payload: { Estado: 'CERRADA' } },
    ],
    Demandas: [
      { id: 'd1', payload: { Estado: 'Cerrada' } },
      { id: 'd2', payload: { Estado: 'Abierta' } },
    ],
    Hechos_Compartidos: [{ id: 'h1', payload: { Asunto: 'agua potable' } }],
    Dialogos: [{ id: 'd1', payload: { Tema: 'Agua potable', Proyecto_ID: 'PRJ-SECHURA' } }],
  },
  'ACME/NORTE': {
    Hechos_Compartidos: [{ id: 'n1', payload: { Proyecto_ID: 'NORTE' } }],
  },
};

const setup = (scope: Scope, projectLabel?: (scope: Scope) => Promise<string | null>) => {
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
    renderer: docxRenderer,
    ...(projectLabel ? { projectLabel } : {}),
  });
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set('scope', scope);
      await next();
    })
    .route('/', analyticsRoutes({ analytics }));
  return { app, requested };
};

const SECHURA = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };

describe('analytics HTTP routes', () => {
  it('GET /api/dashboard counts the scope records like app.py', async () => {
    const { app } = setup(SECHURA);
    const body = DashboardResponse.parse(await (await app.request('/api/dashboard')).json());
    expect(body).toEqual({
      eventos: 1,
      actores: 0,
      demandas_abiertas: 1,
      alertas_activas: 1,
      directorio: 0,
      priorizados: 0,
      niveles: { Rojo: 1, Verde: 1, 'Sin nivel': 1 },
    });
  });

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

  it('names the situational project from the tenant label without a Proyectos record', async () => {
    const asked: string[] = [];
    const { app } = setup({ companyId: 'ACME', projectId: 'NORTE' }, async (s) => {
      asked.push(`${s.companyId}/${s.projectId}`);
      return 'Proyecto Norte';
    });
    const body = SituationalAnalysisResponse.parse(
      await (await app.request('/system/situational-analysis')).json(),
    );
    expect(body.project_name).toBe('Proyecto Norte');
    expect(asked).toEqual(['ACME/NORTE']);
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

/** Plain text of every paragraph in a DOCX body, in order. */
const docxText = async (res: Response) => {
  const xml = strFromU8(
    unzipSync(new Uint8Array(await res.arrayBuffer()))['word/document.xml'] ?? new Uint8Array(),
  );
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) =>
    [...p[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''),
  );
};

describe('analytics DOCX reports', () => {
  const sechura: Scope = { companyId: 'SIPGES', projectId: 'PRJ-SECHURA' };

  it.each([
    [
      '/system/situational-report.docx',
      'SIPGES_Analisis_Situacional.docx',
      'INFORME DE ANÁLISIS SITUACIONAL',
    ],
    [
      '/system/strategic-report.docx',
      'SIPGES_Informe_Estrategico.docx',
      'SIPGES | Informe estratégico territorial',
    ],
    [
      '/system/integrated-analysis.docx',
      'SIPGES_RC19_Analisis_Integrado.docx',
      'SIPGES | Análisis integrado RC 1.9',
    ],
    [
      '/system/consensus-engine.docx',
      'SIPGES_Motor_Valor_Consenso.docx',
      'SIPGES | Motor de valor y consenso',
    ],
  ])('%s downloads %s', async (path, fileName, heading) => {
    const res = await setup(sechura).app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${fileName}"`);
    const text = await docxText(res);
    expect(text[0]).toBe(heading);
    // docs/adr/0008 #13: no hard-coded personal names, unlike app.py's credit lines.
    expect(text.join('\n')).not.toMatch(/Castillo|Granda/);
  });

  it('fills the situational and strategic reports from the scope records', async () => {
    const situational = await docxText(
      await setup(sechura).app.request('/system/situational-report.docx'),
    );
    expect(situational[1]).toBe('Proyecto Sechura | Corte: 2026-10-12T12:00:00Z');
    expect(situational).toContain('Sechura: 1 registros');
    expect(situational.some((line) => line.startsWith('[a1] Rojo:'))).toBe(true);

    const strategic = await docxText(
      await setup(sechura).app.request('/system/strategic-report.docx'),
    );
    expect(strategic).toContain('[d1] Tema: Agua potable');
    expect(strategic).toContain('[h1] Asunto: agua potable');
    expect(strategic).toContain(
      'Sin registros. No es posible emitir conclusiones sobre este componente.',
    );
  });
});
