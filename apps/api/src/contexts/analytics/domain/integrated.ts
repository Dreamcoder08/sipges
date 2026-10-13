import { candidatePairs } from './candidate-links.ts';
import { automatedConsensus } from './consensus.ts';
import type { ExtendedRecords } from './records.ts';

const SCENARIOS = [
  {
    tipo: 'Escenario de mejora',
    supuesto:
      'Los actores revisan discrepancias, se verifican fuentes y se acuerdan pasos con responsables.',
    indicadores_a_observar: [
      'Hechos contrastados',
      'Cumplimiento de compromisos',
      'Participación efectiva',
    ],
  },
  {
    tipo: 'Escenario de continuidad',
    supuesto: 'Permanecen asuntos abiertos y no se actualizan datos ni acuerdos.',
    indicadores_a_observar: [
      'Antigüedad de temas abiertos',
      'Calidad de evidencia',
      'Siguientes pasos vencidos',
    ],
  },
  {
    tipo: 'Escenario de deterioro',
    supuesto: 'Persisten discrepancias y se acumulan compromisos incumplidos corroborados.',
    indicadores_a_observar: [
      'Alertas comprobadas',
      'Demandas pendientes',
      'Cambios documentados en el relacionamiento',
    ],
  },
];

const LIMITATIONS = [
  'Las asociaciones textuales son candidatas, no relaciones verificadas. No se hacen inferencias personales sobre los actores.',
  'Los escenarios son condicionales, no pronósticos ni probabilidades. No se modifica el IRSA.',
  'No se crea ningún compromiso, se asignan presupuestos ni se califica legitimidad sin revisión humana.',
  'Los resultados proceden solo de registros del proyecto y requieren auditoría de fuentes y control de acceso.',
];

/** Integrated analysis (app.py:881, RC 1.9): candidate links plus a draft action plan. */
export const integratedAnalysis = (r: ExtendedRecords, projectId: string, generatedAt: string) => {
  const pairs = candidatePairs(r);
  const actions = automatedConsensus(r, projectId, generatedAt).recommendations.map((c, i) => ({
    numero: i + 1,
    accion: c.accion_sugerida,
    objetivo: c.titulo,
    fundamento: c.motivo,
    registros: c.registros_relacionados,
    prioridad_orientativa: c.prioridad_orientativa,
    responsable: 'Por asignar tras revisión',
    plazo: 'Por acordar',
    estado: 'Borrador automático — no aprobado',
  }));
  return {
    project_id: projectId,
    generated_at: generatedAt,
    version: '1.9',
    summary: {
      cruces_candidatos: pairs.length,
      acciones_sugeridas: actions.length,
      registros_estrategicos: Object.values(r).reduce((n, items) => n + items.length, 0),
    },
    candidate_links: pairs,
    action_plan: actions,
    scenarios: SCENARIOS,
    limitations: LIMITATIONS,
  };
};

export type IntegratedAnalysis = ReturnType<typeof integratedAnalysis>;
