import { pyGet, pyStr, pyStrip } from './python.ts';
import { type AnalysisRecord, type ExtendedRecords, extendedCounts } from './records.ts';

const state = (x: AnalysisRecord) => pyStr(pyGet(x, 'Estado')).toLowerCase();

export const FACT_CLOSED = ['validado', 'cerrado', 'descartado'];
export const OPPORTUNITY_CLOSED = ['descartada', 'descartado', 'cerrada', 'cerrado'];
export const DIALOGUE_CLOSED = ['cerrado', 'cerrada', 'finalizado'];
export const AARC_DIMENSIONS = [
  ['Reconocimiento', 'reconocimiento'],
  ['Agencia', 'agencia'],
  ['Reciprocidad', 'reciprocidad'],
  ['Claridad', 'claridad'],
] as const;

const LIMITATIONS = [
  'Métricas descriptivas sobre registros: no representan un índice de consenso ni una estimación predictiva.',
  'Las calificaciones AARC, cuando existan, son observaciones cualitativas; no se incorporan al IRSA.',
  'Registrar fuentes, fecha y validación antes de tomar decisiones o comunicar resultados.',
];

/** Strategic assessment (app.py:715): descriptive metrics of the RC 1.7 second layer. */
export const strategicAssessment = (r: ExtendedRecords, projectId: string, generatedAt: string) => {
  const pending = r.hechos.filter((x) => !FACT_CLOSED.includes(state(x)));
  const opportunities = r.oportunidades.filter((x) => !OPPORTUNITY_CLOSED.includes(state(x)));
  const dialogues = r.dialogos.filter((x) => !DIALOGUE_CLOSED.includes(state(x)));
  const completed = r.aarc.filter((x) => AARC_DIMENSIONS.every(([key]) => pyStrip(pyGet(x, key))));
  return {
    project_id: projectId,
    generated_at: generatedAt,
    counts: extendedCounts(r),
    facts_pending: pending.length,
    opportunities_open: opportunities.length,
    dialogues_open: dialogues.length,
    aarc_complete: completed.length,
    attention: [
      ...(pending.length
        ? ['Existen hechos o datos pendientes de contraste documental y validación conjunta.']
        : []),
      ...(dialogues.length
        ? ['Existen procesos de diálogo registrados que requieren seguimiento.']
        : []),
      ...(opportunities.length
        ? ['Existen oportunidades registradas cuya viabilidad y responsables deben revisarse.']
        : []),
    ],
    limitations: LIMITATIONS,
  };
};

export type StrategicAssessment = ReturnType<typeof strategicAssessment>;
