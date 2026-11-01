import { type ReportDocument, bullet, heading, paragraph, title } from '@sipges/kernel';
import type { ConsensusReport } from './consensus.ts';
import type { IntegratedAnalysis } from './integrated.ts';
import { pyGet, pyStr, pyTruthy } from './python.ts';
import type { ExtendedKey, ExtendedRecords } from './records.ts';
import type { SituationalAnalysis } from './situational.ts';
import type { StrategicAssessment } from './strategic.ts';

/**
 * Word report outlines of app.py:679, 906, 936 and 955. Text keeps parity, except that the
 * hard-coded author credits of the consensus and strategic reports are not ported
 * (docs/adr/0008 #13: no personal names in code).
 */

export const REPORT_FILENAMES = {
  situational: 'SIPGES_Analisis_Situacional.docx',
  integrated: 'SIPGES_RC19_Analisis_Integrado.docx',
  consensus: 'SIPGES_Motor_Valor_Consenso.docx',
  strategic: 'SIPGES_Informe_Estrategico.docx',
} as const;

const source = (x: Readonly<Record<string, unknown>>) =>
  pyTruthy(pyGet(x, 'Fuente_ID', null)) ? pyStr(x['Fuente_ID']) : 'no consignada';

export const situationalReport = (data: SituationalAnalysis): ReportDocument => ({
  blocks: [
    title('INFORME DE ANÁLISIS SITUACIONAL'),
    paragraph(`${pyStr(data.project_name)} | Corte: ${data.generated_at}`),
    paragraph(
      'Documento generado automáticamente por SIPGES (Sistema Inteligente de Predicción y GEStión Social). BORRADOR SUJETO A REVISIÓN Y VALIDACIÓN.',
    ),
    heading(1, '1. Resumen ejecutivo'),
    paragraph(
      `Se integraron ${data.counts.eventos} eventos, ${data.counts.actores} actores, ${data.demandas_pendientes} demandas pendientes y ${data.alertas_activas} alertas activas en la Base Maestra del proyecto. Las cifras indican registros, no hechos necesariamente corroborados.`,
    ),
    heading(1, '2. Diagnóstico de la situación'),
    ...data.observaciones.map(bullet),
    heading(1, '3. Territorios con eventos registrados'),
    ...data.territorios.map(([name, count]) => bullet(`${name}: ${count} registros`)),
    heading(1, '4. Demandas y asuntos relevantes'),
    ...data.demandas_abiertas.map((x) =>
      bullet(
        `[${x.id}] ${pyStr(pyGet(x, 'Tema'))} — ${pyStr(pyGet(x, 'Descripcion'))} (Fuente: ${source(x)})`,
      ),
    ),
    heading(1, '5. Alertas prioritarias'),
    ...data.alertas_prioritarias.map((x) =>
      bullet(
        `[${x.id}] ${pyStr(pyGet(x, 'Nivel_Preliminar', 'Sin nivel'))}: ${pyStr(pyGet(x, 'Causa'))} (Fuente: ${source(x)})`,
      ),
    ),
    heading(1, '6. Escenarios condicionales'),
    ...data.escenarios.map((x) => bullet(`${x.nombre}: ${x.supuesto}`)),
    heading(1, '7. Recomendaciones'),
    ...data.recomendaciones.map(bullet),
    heading(1, '8. Alcances y limitaciones'),
    ...data.limitations.map(bullet),
    paragraph(
      'Preparado por: Sistema SIPGES | Revisión técnica: __________________ | Fecha de validación: ______________',
    ),
  ],
});

export const integratedReport = (d: IntegratedAnalysis): ReportDocument => ({
  blocks: [
    title('SIPGES | Análisis integrado RC 1.9'),
    paragraph(`Proyecto ${d.project_id} · Corte ${d.generated_at}`),
    paragraph(
      'DOCUMENTO AUTOMÁTICO EN BORRADOR. Los vínculos no están confirmados; requiere revisión profesional y contrastación de fuentes.',
    ),
    heading(1, '1. Cruces candidatos entre módulos'),
    ...(d.candidate_links.length === 0
      ? [paragraph('Sin coincidencias verificables suficientes en los registros disponibles.')]
      : d.candidate_links.map((x) =>
          bullet(
            `${x.origen} ↔ ${x.destino} | ${x.criterio} | términos: ${x.terminos_compartidos.join(', ')}`,
          ),
        )),
    heading(1, '2. Plan de acción propuesto'),
    ...(d.action_plan.length === 0
      ? [
          paragraph(
            'Sin acciones generadas; la ausencia de registros no demuestra ausencia de riesgo.',
          ),
        ]
      : d.action_plan.flatMap((x) => [
          heading(2, `${x.numero}. ${x.objetivo}`),
          paragraph(
            `Acción: ${x.accion}\nFundamento: ${x.fundamento}\nRegistros: ${x.registros.join(', ')}\nResponsable: por asignar | Estado: no aprobado`,
          ),
        ])),
    heading(1, '3. Escenarios condicionales (no predicciones)'),
    ...d.scenarios.flatMap((x) => [
      heading(2, x.tipo),
      paragraph(x.supuesto),
      paragraph(`Indicadores: ${x.indicadores_a_observar.join(', ')}`),
    ]),
    heading(1, '4. Alcances y salvaguardas'),
    ...d.limitations.map(bullet),
    paragraph('Revisado por: __________________  Fecha: _________________'),
  ],
});

const CONSENSUS_FIELDS = [
  ['Enfoque', 'tipo'],
  ['Hallazgo de registro', 'motivo'],
  ['Acción sugerida', 'accion_sugerida'],
  ['Procedencia', 'origen'],
  ['Nivel orientativo', 'prioridad_orientativa'],
] as const;

export const consensusReport = (report: ConsensusReport): ReportDocument => ({
  blocks: [
    title('SIPGES | Motor de valor y consenso'),
    paragraph(`Proyecto: ${report.project_id} · Corte: ${report.generated_at}`),
    paragraph(
      'BORRADOR AUTOMATIZADO: recomendaciones basadas en registros y reglas. REVISIÓN OBLIGATORIA.',
    ),
    ...report.recommendations.flatMap((x, i) => [
      heading(2, `${i + 1}. ${x.titulo}`),
      ...CONSENSUS_FIELDS.map(([name, key]) => paragraph(`${name}: ${x[key]}`)),
    ]),
    heading(1, 'Limitaciones'),
    ...report.limitations.map(bullet),
    paragraph('Revisó: ______________________ Fecha: __________'),
  ],
});

const STRATEGIC_SECTIONS: readonly (readonly [string, ExtendedKey, readonly string[]])[] = [
  [
    '2. Mapeo de intereses',
    'intereses',
    ['Actor', 'Posicion', 'Interes', 'Preocupacion', 'Fuente_ID'],
  ],
  [
    '3. Procesos de diálogo y acuerdos',
    'dialogos',
    ['Proceso', 'Participantes', 'Tema', 'Estado', 'Proximo_Paso'],
  ],
  [
    '4. Valor compartido',
    'oportunidades',
    ['Oportunidad', 'Beneficiarios', 'Viabilidad', 'Estado', 'Responsable'],
  ],
  [
    '5. Hechos compartidos y controversias',
    'hechos',
    ['Asunto', 'Estado', 'Versiones', 'Fuente_ID', 'Accion_Verificacion'],
  ],
  [
    '6. Evaluaciones AARC',
    'aarc',
    ['Actor_Proceso', 'Reconocimiento', 'Agencia', 'Reciprocidad', 'Claridad', 'Evidencia'],
  ],
];

export const strategicReport = (
  records: ExtendedRecords,
  report: StrategicAssessment,
  situation: SituationalAnalysis,
): ReportDocument => ({
  blocks: [
    title('SIPGES | Informe estratégico territorial'),
    paragraph(`${pyStr(situation.project_name)} | Corte: ${report.generated_at}`),
    paragraph(
      'BORRADOR AUTOMATIZADO — REQUIERE REVISIÓN Y APROBACIÓN. No sustituye decisiones institucionales.',
    ),
    heading(1, '1. Situación social documentada'),
    ...situation.observaciones.map(bullet),
    ...STRATEGIC_SECTIONS.flatMap(([sectionTitle, key, fields]) => [
      heading(1, sectionTitle),
      ...(records[key].length === 0
        ? [paragraph('Sin registros. No es posible emitir conclusiones sobre este componente.')]
        : records[key].slice(0, 40).map((record) =>
            bullet(
              `[${record._id}] ${fields
                .filter((field) => pyTruthy(pyGet(record, field, null)))
                .map((field) => `${field}: ${pyStr(record[field])}`)
                .join(' | ')}`,
            ),
          )),
    ]),
    heading(1, '7. Alertas metodológicas'),
    ...report.limitations.map(bullet),
    paragraph('Validado por: _________________________    Fecha: __________________'),
  ],
});
