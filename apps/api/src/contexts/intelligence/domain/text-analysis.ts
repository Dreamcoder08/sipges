import { codePoints, foldMarks, hasWholeWord, pyStr, pyTruthy, sliceCodePoints } from './python.ts';

/**
 * Transparent keyword analysis of transcribed public text (app.py:1910-2003, RC 2.4) and the
 * optional local semantic layer (RC 2.5). Nothing is fetched from the source URL.
 */

export const TEXT_TERMS: Readonly<Record<string, readonly string[]>> = {
  'Gobernanza y representación': [
    'directiva',
    'eleccion',
    'presidente',
    'asamblea',
    'representacion',
    'comunidad campesina',
    'administracion',
    'dirigente',
  ],
  'Territorio y tierras': [
    'territorio',
    'tierras',
    'concesion',
    'servidumbre',
    'predio',
    'linderos',
    'ocupacion',
  ],
  'Empleo y economía local': [
    'empleo',
    'trabajo',
    'contratacion',
    'proveedor',
    'beneficio',
    'salario',
    'inversion',
  ],
  'Ambiente y agua': [
    'agua',
    'contaminacion',
    'ambiente',
    'impacto',
    'polvo',
    'residuo',
    'ecosistema',
  ],
  'Diálogo y compromisos': [
    'dialogo',
    'reunion',
    'acuerdo',
    'compromiso',
    'mesa de trabajo',
    'informacion',
    'consulta',
  ],
  'Protesta y conflictividad': [
    'protesta',
    'paro',
    'bloqueo',
    'movilizacion',
    'conflicto',
    'denuncia',
    'rechazo',
  ],
  'Seguridad y emergencias': [
    'accidente',
    'amenaza',
    'riesgo',
    'emergencia',
    'seguridad',
    'evacuacion',
  ],
};

export const TEXT_SIGNALS: Readonly<Record<string, readonly string[]>> = {
  'Movilización anunciada': ['paro', 'marcha', 'movilizacion', 'bloqueo', 'planton'],
  'Demanda o reclamo': ['exigimos', 'reclamamos', 'solicitamos', 'demanda', 'incumplimiento'],
  'Convocatoria a reunión': ['convocatoria', 'asamblea', 'reunion', 'mesa de dialogo'],
  'Información no corroborada': [
    'dicen que',
    'se rumorea',
    'supuestamente',
    'trascendio',
    'al parecer',
  ],
};

export const SEMANTIC_CONCEPTS: Readonly<Record<string, string>> = {
  'Ambiente y agua':
    'Preocupaciones comunitarias por calidad de agua, contaminación ambiental, impacto ecológico y salud ambiental.',
  'Gobernanza y representación':
    'Legitimidad de dirigencias comunales, decisiones de asamblea, elecciones y representación institucional.',
  'Territorio y uso de tierras':
    'Acceso a predios, servidumbres, concesiones mineras, propiedad, límites y uso de tierras.',
  'Trabajo y economía local':
    'Oportunidades de empleo, contratación local, proveedores, ingresos y beneficios económicos.',
  'Diálogo y compromisos':
    'Solicitudes de reunión, acuerdos pendientes, incumplimientos, mesas de diálogo y negociación.',
  'Movilización social':
    'Convocatorias públicas de marcha, protestas, paros y reuniones colectivas de protesta.',
  'Seguridad y emergencia':
    'Accidentes operacionales, riesgos de seguridad física, emergencias y evacuación.',
};

export const MAX_TEXT_LENGTH = 20_000;
export const SEMANTIC_THRESHOLD = 0.38;

export type Topic = { tema: string; terminos_detectados: string[]; cantidad: number };
export type TextSignal = { senal: string; terminos_detectados: string[] };

const LEGACY_PROJECT_ID = 'PRJ-SECHURA';

/** Project of a narrative record, as app.py filtered `records_of('Narrativas')`. */
const recordProject = (payload: Readonly<Record<string, unknown>>) => {
  if (pyTruthy(payload['Proyecto_ID'])) return pyStr(payload['Proyecto_ID']);
  if (pyTruthy(payload['project_id'])) return pyStr(payload['project_id']);
  return LEGACY_PROJECT_ID;
};

export type TextAnalysisError = { readonly kind: 'empty' } | { readonly kind: 'too_long' };

export const analyzeText = (
  input: { text: string; projectId: string; sourceUrl: string },
  narratives: readonly Readonly<Record<string, unknown>>[],
  sha256: (text: string) => string,
): { ok: true; value: ReturnType<typeof textReport> } | { ok: false; error: TextAnalysisError } => {
  const content = input.text.trim();
  if (!content) return { ok: false, error: { kind: 'empty' } };
  if (codePoints(content).length > MAX_TEXT_LENGTH)
    return { ok: false, error: { kind: 'too_long' } };
  return { ok: true, value: textReport(content, input, narratives, sha256) };
};

const textReport = (
  content: string,
  input: { projectId: string; sourceUrl: string },
  narratives: readonly Readonly<Record<string, unknown>>[],
  sha256: (text: string) => string,
) => {
  const norm = foldMarks(content);
  const topics: Topic[] = [];
  for (const [tema, words] of Object.entries(TEXT_TERMS)) {
    const found = words.filter((w) => hasWholeWord(norm, w));
    if (found.length) topics.push({ tema, terminos_detectados: found, cantidad: found.length });
  }
  topics.sort(
    (a, b) => b.cantidad - a.cantidad || (a.tema < b.tema ? -1 : a.tema > b.tema ? 1 : 0),
  );
  const signals: TextSignal[] = [];
  for (const [senal, words] of Object.entries(TEXT_SIGNALS)) {
    const found = words.filter((w) => hasWholeWord(norm, w));
    if (found.length) signals.push({ senal, terminos_detectados: found });
  }
  // No authorship, truthfulness, personal threat or conflict probability is inferred.
  const score = Math.min(100, Math.min(50, signals.length * 15) + Math.min(30, topics.length * 6));
  const level = score >= 65 ? 'Alta' : score >= 35 ? 'Media' : 'Baja';

  const counts = new Map<string, number>();
  for (const record of narratives.filter((r) => recordProject(r) === input.projectId)) {
    const rt = foldMarks(
      ['Tema', 'Descripcion'].map((k) => (pyTruthy(record[k]) ? pyStr(record[k]) : '')).join(' '),
    );
    for (const t of topics) {
      if ((TEXT_TERMS[t.tema] ?? []).some((w) => rt.includes(w)))
        counts.set(t.tema, (counts.get(t.tema) ?? 0) + 1);
    }
  }

  const has = (name: string) => signals.some((s) => s.senal === name);
  const suggestions: string[] = [];
  if (has('Movilización anunciada'))
    suggestions.push(
      'Verificar convocatoria, fecha, lugar y fuente antes de actualizar el nivel de riesgo.',
    );
  if (has('Demanda o reclamo'))
    suggestions.push(
      'Revisar si existe un compromiso o demanda vinculada en el registro territorial.',
    );
  if (has('Información no corroborada'))
    suggestions.push(
      'Solicitar corroboración documental antes de difundir o escalar el contenido.',
    );
  if (topics.length)
    suggestions.push(
      'Contrastar el hallazgo con fuentes, actores institucionales y evidencia de campo.',
    );
  if (!suggestions.length)
    suggestions.push(
      'Registrar y verificar contexto; no hay términos suficientes para emitir una alerta temática.',
    );

  return {
    version: '2.4',
    project_id: input.projectId,
    source_url: input.sourceUrl,
    analyzed_chars: codePoints(content).length,
    topics,
    signals,
    orientation: {
      score,
      level,
      meaning:
        'Prioridad de revisión textual, no probabilidad de conflicto ni valoración de una persona.',
    },
    project_comparison: topics.map((t) => ({
      tema: t.tema,
      registros_relacionados_por_palabras: counts.get(t.tema) ?? 0,
    })),
    suggested_actions: suggestions,
    evidence: { fragment: sliceCodePoints(content, 500), sha256: sha256(content) },
    method:
      'Coincidencia determinista de palabras clave normalizadas; sin inteligencia artificial generativa ni extracción automática.',
    limitations: [
      'No valida la autenticidad ni el contenido del enlace.',
      'No permite afirmar causalidad, sentimientos, intenciones o riesgo individual.',
      'Confirmar con fuentes y revisión.',
      'El texto enviado no se guarda por este endpoint.',
    ],
  };
};

export type TextReport = ReturnType<typeof textReport>;

/** Cosine similarity; vectors of different length are unrelated (app.py `_rc25_cos`). */
export const cosine = (a: readonly number[], b: readonly number[]) => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

/** `urlsplit(url)` has an http(s) scheme and a network location. */
export const isPublicHttpUrl = (url: string) => {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  return Boolean(match && ['http', 'https'].includes((match[1] ?? '').toLowerCase()) && match[2]);
};
