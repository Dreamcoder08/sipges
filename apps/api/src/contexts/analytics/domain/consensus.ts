import { pyGet, pyStr, pyStrip } from './python.ts';
import { type ExtendedRecords, extendedCounts } from './records.ts';
import { AARC_DIMENSIONS, DIALOGUE_CLOSED, FACT_CLOSED, OPPORTUNITY_CLOSED } from './strategic.ts';

export type Priority = 'Alta' | 'Media';

export type ConsensusCard = {
  readonly tipo: string;
  readonly titulo: string;
  readonly motivo: string;
  readonly accion_sugerida: string;
  readonly origen: string;
  readonly registros_relacionados: readonly string[];
  readonly prioridad_orientativa: Priority;
  readonly estado: string;
  readonly autorizacion: string;
};

const LIMITATIONS = [
  'Los disparadores indican faltantes de registros, no defectos reales de personas ni instituciones.',
  'El módulo no modifica IRSA, no aprueba acuerdos, no compromete presupuesto y no produce diagnósticos de legitimidad.',
  'Los registros deben tener fuentes, controles de acceso y revisión profesional antes del uso institucional.',
];

const lower = (value: unknown) => pyStr(value).toLowerCase();

/** Rule families that only read record fields; one card per (type, origin, title). */
const collectCards = (r: ExtendedRecords): ConsensusCard[] => {
  const cards: ConsensusCard[] = [];
  const add = (
    tipo: string,
    titulo: string,
    motivo: string,
    accion_sugerida: string,
    origen: string,
    registros_relacionados: readonly string[] = [],
    prioridad_orientativa: Priority = 'Media',
  ) => {
    if (cards.some((c) => c.tipo === tipo && c.origen === origen && c.titulo === titulo)) return;
    cards.push({
      tipo,
      titulo,
      motivo,
      accion_sugerida,
      origen,
      registros_relacionados,
      prioridad_orientativa,
      estado: 'Propuesta automática; pendiente de revisión humana',
      autorizacion: 'No constituye acuerdo ni compromiso',
    });
  };

  for (const x of r.hechos) {
    const id = x._id;
    if (!FACT_CLOSED.includes(lower(pyGet(x, 'Estado')).trim()))
      add(
        'Hechos compartidos',
        'Preparar verificación conjunta de información',
        'El asunto consta como no validado; no se debe resolver una controversia a partir de una sola versión.',
        'Acordar preguntas, fuentes, metodología, responsables y criterios de validación con los actores participantes.',
        `hechos/${id}`,
        [id],
        'Alta',
      );
    if (!pyStrip(pyGet(x, 'Fuente_ID')))
      add(
        'Calidad de evidencia',
        'Completar fuentes de la controversia',
        'El registro no tiene Fuente_ID.',
        'Vincular al menos una evidencia rastreable antes de emitir conclusiones.',
        `hechos/${id}`,
        [id],
        'Alta',
      );
  }

  for (const x of r.intereses) {
    const id = x._id;
    const actor = pyStrip(pyGet(x, 'Actor')) || id;
    if (!pyStrip(pyGet(x, 'Interes')))
      add(
        'Negociación por intereses',
        'Explorar intereses expresados, sin inferirlos',
        `El actor ${actor} tiene una ficha sin interés documentado.`,
        'Programar escucha consultiva y registrar los intereses declarados con evidencia y consentimiento.',
        `intereses/${id}`,
        [id],
      );
    if (!pyStrip(pyGet(x, 'Mandato')))
      add(
        'Representatividad',
        'Verificar mandato antes de acuerdos formales',
        `La ficha de ${actor} no registra sustento documental de mandato.`,
        'Solicitar documentación de representación y registrar su vigencia; no asumir falta de legitimidad.',
        `intereses/${id}`,
        [id],
        'Alta',
      );
    if (pyStrip(pyGet(x, 'Preocupacion')) && !pyStrip(pyGet(x, 'Fuente_ID')))
      add(
        'Información compartida',
        'Documentar origen de preocupación',
        'Se registró una preocupación sin fuente trazable.',
        'Documentar declaración original, fecha, contexto y autorización de uso.',
        `intereses/${id}`,
        [id],
      );
  }

  for (const x of r.dialogos) {
    const id = x._id;
    if (DIALOGUE_CLOSED.includes(lower(pyGet(x, 'Estado')))) continue;
    if (!pyStrip(pyGet(x, 'Proximo_Paso')) || !pyStrip(pyGet(x, 'Responsable')))
      add(
        'Arquitectura de consenso',
        'Definir seguimiento del diálogo',
        'El proceso abierto no tiene responsable o siguiente paso completo.',
        'Acordar responsable, plazo, mecanismo de rendición de cuentas y forma de gestionar desacuerdos.',
        `dialogos/${id}`,
        [id],
        'Alta',
      );
    if (!pyStrip(pyGet(x, 'Fuente_ID')))
      add(
        'Trazabilidad',
        'Vincular acta o evidencia del proceso',
        'El proceso de diálogo no presenta una fuente identificada.',
        'Adjuntar acta, registro consentido o evidencia verificable.',
        `dialogos/${id}`,
        [id],
      );
  }

  for (const x of r.oportunidades) {
    const id = x._id;
    if (OPPORTUNITY_CLOSED.includes(lower(pyGet(x, 'Estado')))) continue;
    if (!pyStrip(pyGet(x, 'Viabilidad')) || !pyStrip(pyGet(x, 'Restricciones')))
      add(
        'Mutual Gains / valor compartido',
        'Examinar viabilidad de oportunidad',
        'La oportunidad registrada necesita evaluación técnica, legal o presupuestal.',
        'Contrastar beneficios para cada actor, restricciones, financiamiento y opciones alternativas; no presentarla como promesa.',
        `oportunidades/${id}`,
        [id],
      );
    if (!pyStrip(pyGet(x, 'Responsable')))
      add(
        'Gobernanza adaptativa',
        'Asignar responsable de evaluación',
        'La oportunidad abierta no tiene un responsable de seguimiento documentado.',
        'Definir responsable de evaluar, sin convertir una propuesta en compromiso.',
        `oportunidades/${id}`,
        [id],
      );
  }

  for (const x of r.aarc) {
    const id = x._id;
    const missing = AARC_DIMENSIONS.filter(([key]) => !pyStrip(pyGet(x, key))).map(
      ([, label]) => label,
    );
    if (missing.length)
      add(
        'AARC / relacionamiento',
        'Completar evaluación cualitativa AARC',
        `Dimensiones sin documentación: ${missing.join(', ')}.`,
        'Recoger observaciones verificables con participación de los involucrados; evitar una puntuación ficticia.',
        `aarc/${id}`,
        [id],
      );
    else if (!pyStrip(pyGet(x, 'Evidencia')))
      add(
        'AARC / evidencia',
        'Sustentar evaluación AARC',
        'La evaluación registra las cuatro dimensiones sin evidencia indicada.',
        'Vincular hechos observables, fuentes y fecha de evaluación.',
        `aarc/${id}`,
        [id],
      );
  }

  // Cross-module recommendation: only from verifiable records of the same project.
  if (r.intereses.length && r.oportunidades.length)
    add(
      'Integración intereses-valor',
      'Contrastar intereses con cartera de oportunidades',
      'Existen fichas de intereses y oportunidades para el mismo proyecto; no se presume coincidencia ni apoyo.',
      'Revisar conjuntamente la correspondencia y documentar coincidencias, desacuerdos y restricciones antes de generar opciones.',
      'intereses+oportunidades',
      [...r.intereses.slice(0, 3), ...r.oportunidades.slice(0, 3)].map((x) => x._id),
    );
  const [firstFact] = r.hechos;
  const [firstDialogue] = r.dialogos;
  if (firstFact && firstDialogue)
    add(
      'Integración hechos-diálogo',
      'Incluir controversias verificables en la agenda de diálogo',
      'El proyecto registra tanto procesos de diálogo como asuntos sujetos a verificación.',
      'Preguntar a los participantes qué hechos necesitan verificar juntos y acordar un procedimiento transparente.',
      'hechos+dialogos',
      [firstFact._id, firstDialogue._id],
    );
  return cards;
};

/**
 * Deterministic engine of traceable recommendations (app.py:745 automated_consensus, RC 1.8).
 * Cards are drafts, never agreements, diagnoses or validated facts.
 */
export const automatedConsensus = (r: ExtendedRecords, projectId: string, generatedAt: string) => {
  const cards = collectCards(r);
  return {
    project_id: projectId,
    generated_at: generatedAt,
    method: 'reglas trazables v1.8 (sin inferencia predictiva ni IA generativa)',
    counts: extendedCounts(r),
    recommendations: cards,
    summary: {
      total: cards.length,
      alta: cards.filter((c) => c.prioridad_orientativa === 'Alta').length,
    },
    limitations: LIMITATIONS,
  };
};

export type ConsensusReport = ReturnType<typeof automatedConsensus>;
