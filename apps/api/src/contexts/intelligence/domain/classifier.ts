import { foldMarks, pyJsonDumps, pyRound } from './python.ts';

/**
 * Calibrated lexical classifier of a territorial record into one SIPGES dimension
 * (app.py:1207-1320, version 0.5.1). Suggestions only; never persisted.
 */

type Lexicon = { readonly strong: readonly string[]; readonly weak: readonly string[] };

export const DIMENSIONS = ['G', 'A', 'D', 'N', 'E', 'I'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const CLASSIFIER_LEXICON: Readonly<Record<Dimension, Lexicon>> = {
  G: {
    strong: [
      'representacion legal',
      'facultades',
      'gobernanza',
      'padron',
      'eleccion',
      'interlocucion',
      'junta transitoria',
      'administrador judicial',
      'legitimidad comunal',
      'organo comunal',
      'representacion fragmentada',
    ],
    weak: [
      'comunal',
      'judicial',
      'sunarp',
      'bdpi',
      'consulta previa',
      'directiva',
      'fundacion comunal',
    ],
  },
  A: {
    strong: [
      'mapa de actores',
      'capacidad de influencia',
      'influencia alta',
      'capacidad de movilizacion',
      'movilizacion alta',
      'alianza',
      'actor critico',
      'liderazgo',
    ],
    weak: ['actor', 'organizacion', 'convocatoria', 'relacionamiento', 'roles'],
  },
  D: {
    strong: [
      'demanda',
      'demandas',
      'solicitan',
      'solicitud',
      'compromiso',
      'empleo',
      'proveedores',
      'beneficios',
      'capacitacion',
      'expectativas',
    ],
    weak: ['agenda', 'atencion', 'pedido', 'requerimiento'],
  },
  N: {
    strong: [
      'narrativa',
      'facebook',
      'medios digitales',
      'redes sociales',
      'notas periodisticas',
      'prensa',
      'publicaciones',
      'tono negativo',
      'no verificado',
      'desinformacion',
    ],
    weak: ['controversia', 'exposicion publica', 'reputacional', 'comentarios'],
  },
  E: {
    strong: [
      'agua',
      'pesca',
      'maricultura',
      'biodiversidad',
      'pozo',
      'ganadero',
      'ganado',
      'servidumbre',
      'derechos superficiales',
      'territorio',
      'ambiental',
    ],
    weak: ['saneamiento', 'acceso', 'rutas', 'agricultor', 'agricolas', 'bahia', 'transito'],
  },
  I: {
    strong: [
      'convocatoria formal',
      'cargos firmados',
      'carta de invitacion',
      'comunicacion institucional',
      'trazabilidad',
      'coordinacion institucional',
      'oficio',
      'subprefectura',
      'proinversion',
      'minem',
      'fase de estructuracion',
      'contrato/bases',
      'concurso internacional',
      'adjudicacion',
    ],
    weak: [
      'institucional',
      'resolucion',
      'coordinacion',
      'municipalidad',
      'cronograma',
      'hitos',
      'presentacion',
    ],
  },
};

export const DIMENSION_LABELS: Readonly<Record<Dimension, string>> = {
  G: 'Gobernanza y representación',
  A: 'Actores e influencia',
  D: 'Demandas y compromisos',
  N: 'Narrativas y señales digitales',
  E: 'Ambiental-territorial',
  I: 'Institucional y trazabilidad',
};

type Signal = { signal: string; weight: number };

const any = (text: string, words: readonly string[]) => words.some((w) => text.includes(w));

export const classifyRecord = (payload: unknown) => {
  const text = foldMarks(pyJsonDumps(payload), 'NFD');
  const scores = Object.fromEntries(DIMENSIONS.map((d) => [d, 0])) as Record<Dimension, number>;
  const evidence = Object.fromEntries(DIMENSIONS.map((d) => [d, [] as Signal[]])) as Record<
    Dimension,
    Signal[]
  >;
  const add = (d: Dimension, signal: string, weight: number) => {
    scores[d] += weight;
    evidence[d].push({ signal, weight });
  };

  for (const d of DIMENSIONS) {
    for (const phrase of CLASSIFIER_LEXICON[d].strong) if (text.includes(phrase)) add(d, phrase, 4);
    for (const phrase of CLASSIFIER_LEXICON[d].weak) if (text.includes(phrase)) add(d, phrase, 1.5);
  }

  // General context rules; they never use case ids or the expected dimension.
  if (
    any(text, ['facebook', 'medios digitales', 'notas periodisticas', 'prensa', 'redes sociales'])
  )
    add('N', 'canal digital/periodístico', 5);
  if (
    any(text, [
      'convocatoria formal',
      'cargos firmados',
      'fase de estructuracion',
      'comunicacion institucional',
    ])
  )
    add('I', 'acto/comunicación institucional trazable', 5);
  if (
    text.includes('mapa de actores') ||
    (text.includes('influencia') && text.includes('movilizacion'))
  )
    add('A', 'influencia + movilización / mapa de actores', 5);
  if (text.includes('demanda') || text.includes('demandas')) add('D', 'demanda explícita', 4);
  if (any(text, ['agua', 'pozo', 'pesca', 'maricultura', 'derechos superficiales']))
    add('E', 'componente ambiental/territorial explícito', 3);
  if (
    text.includes('administrador judicial') &&
    (text.includes('facultades') || text.includes('representacion legal'))
  )
    add('G', 'facultades + representación/interlocución', 6);
  if (text.includes('mina de sal') && any(text, ['enfrentamiento', 'control', 'posesion']))
    add('G', 'disputa territorial por control/posesión', 3);

  // Stable sort: ties keep the G, A, D, N, E, I order like Python's sorted().
  const ordered = [...DIMENSIONS].sort((a, b) => scores[b] - scores[a]);
  const dim = ordered[0] ?? 'G';
  const top = scores[dim];
  const second = scores[ordered[1] ?? 'A'];
  const margin = Math.max(0, top - second);
  const confidence =
    top <= 0
      ? 40
      : pyRound(Math.min(94, 55 + Math.min(24, top * 1.5) + Math.min(15, margin * 1.5)));

  let severity = 'Amarillo';
  const critical = any(text, [
    'enfrentamiento',
    'bloqueo',
    'violencia',
    'detenid',
    'riesgo alto',
    'afectacion critica',
    'condicion critica',
  ]);
  const extreme = any(text, ['fallecid', 'grave violencia', 'lesiones graves']);
  if (critical) severity = 'Naranja';
  if (extreme && dim !== 'N') severity = 'Rojo';

  return {
    classifier_version: '0.5.1-calibracion',
    dimension: dim,
    dimension_label: DIMENSION_LABELS[dim],
    confidence,
    nivel_sugerido: severity,
    scores: Object.fromEntries(DIMENSIONS.map((d) => [d, pyRound(scores[d], 2)])),
    margin: pyRound(margin, 2),
    evidence,
    review_required: confidence < 70 || margin < 3,
    nota: 'Sugerencia automática calibrada. No constituye referencia experta ni resultado final de tesis; requiere validación.',
  };
};
