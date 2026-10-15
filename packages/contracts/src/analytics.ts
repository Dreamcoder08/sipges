import { z } from 'zod';

/** Python `Counter.most_common` pair: [label, count]. */
const Tally = z.tuple([z.string(), z.number().int()]);
const TextList = z.array(z.string());

/** Selected record fields (any JSON value, '' when absent) plus the record id. */
const RecordExcerpt = z.object({ id: z.string() }).catchall(z.unknown());

const ExtendedCounts = z.strictObject({
  intereses: z.number().int(),
  dialogos: z.number().int(),
  oportunidades: z.number().int(),
  hechos: z.number().int(),
  aarc: z.number().int(),
});

/** GET /system/situational-analysis (app.py build_situational). */
export const SituationalAnalysisResponse = z.strictObject({
  project_id: z.string(),
  project_name: z.unknown(),
  generated_at: z.string(),
  method: z.string(),
  counts: z.strictObject({
    eventos: z.number().int(),
    actores: z.number().int(),
    demandas: z.number().int(),
    compromisos: z.number().int(),
    narrativas: z.number().int(),
    alertas: z.number().int(),
    acciones: z.number().int(),
    fuentes: z.number().int(),
  }),
  alertas_activas: z.number().int(),
  demandas_pendientes: z.number().int(),
  territorios: z.array(Tally),
  temas_demanda: z.array(Tally),
  niveles_alerta: z.array(Tally),
  eventos_recientes: z.array(RecordExcerpt),
  alertas_prioritarias: z.array(RecordExcerpt),
  demandas_abiertas: z.array(RecordExcerpt),
  actores: z.array(RecordExcerpt),
  observaciones: TextList,
  escenarios: z.array(z.strictObject({ nombre: z.string(), supuesto: z.string() })),
  recomendaciones: TextList,
  limitations: TextList,
});
export type SituationalAnalysisResponse = z.infer<typeof SituationalAnalysisResponse>;

/** GET /system/strategic-assessment. */
export const StrategicAssessmentResponse = z.strictObject({
  project_id: z.string(),
  generated_at: z.string(),
  counts: ExtendedCounts,
  facts_pending: z.number().int(),
  opportunities_open: z.number().int(),
  dialogues_open: z.number().int(),
  aarc_complete: z.number().int(),
  attention: TextList,
  limitations: TextList,
});
export type StrategicAssessmentResponse = z.infer<typeof StrategicAssessmentResponse>;

const Priority = z.enum(['Alta', 'Media']);

export const ConsensusRecommendation = z.strictObject({
  tipo: z.string(),
  titulo: z.string(),
  motivo: z.string(),
  accion_sugerida: z.string(),
  origen: z.string(),
  registros_relacionados: TextList,
  prioridad_orientativa: Priority,
  estado: z.string(),
  autorizacion: z.string(),
});

/** GET /system/consensus-engine (app.py automated_consensus). */
export const ConsensusEngineResponse = z.strictObject({
  project_id: z.string(),
  generated_at: z.string(),
  method: z.string(),
  counts: ExtendedCounts,
  recommendations: z.array(ConsensusRecommendation),
  summary: z.strictObject({ total: z.number().int(), alta: z.number().int() }),
  limitations: TextList,
});
export type ConsensusEngineResponse = z.infer<typeof ConsensusEngineResponse>;

export const CandidateLink = z.strictObject({
  origen: z.string(),
  destino: z.string(),
  criterio: z.string(),
  terminos_compartidos: TextList,
  estado: z.string(),
  uso_sugerido: z.string(),
});

/** GET /system/integrated-analysis (app.py RC 1.9). */
export const IntegratedAnalysisResponse = z.strictObject({
  project_id: z.string(),
  generated_at: z.string(),
  version: z.literal('1.9'),
  summary: z.strictObject({
    cruces_candidatos: z.number().int(),
    acciones_sugeridas: z.number().int(),
    registros_estrategicos: z.number().int(),
  }),
  candidate_links: z.array(CandidateLink).max(120),
  action_plan: z.array(
    z.strictObject({
      numero: z.number().int(),
      accion: z.string(),
      objetivo: z.string(),
      fundamento: z.string(),
      registros: TextList,
      prioridad_orientativa: Priority,
      responsable: z.string(),
      plazo: z.string(),
      estado: z.string(),
    }),
  ),
  scenarios: z.array(
    z.strictObject({ tipo: z.string(), supuesto: z.string(), indicadores_a_observar: TextList }),
  ),
  limitations: TextList,
});
export type IntegratedAnalysisResponse = z.infer<typeof IntegratedAnalysisResponse>;

/** GET /api/dashboard (app.py:984): executive counters of the active scope. */
const DashboardCounters = {
  eventos: z.number().int(),
  actores: z.number().int(),
  demandas_abiertas: z.number().int(),
  alertas_activas: z.number().int(),
  directorio: z.number().int(),
  priorizados: z.number().int(),
};
export const DashboardResponse = z.strictObject({
  ...DashboardCounters,
  niveles: z.record(z.string(), z.number().int()),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;
