import { INDICATOR_CONFIG } from './defaults.ts';
import { firstTruthy, pyFloat, pyRound, pyStr, text } from './python.ts';
import type { IndicatorMeta } from './types.ts';

/**
 * Indicators v0.4 (app.py:1342-1617). Provisional, transparent rules/proxies over the
 * tenant's module records. Pure functions: callers supply records and metadata.
 */

export const DIM_LABELS = {
  G: 'Gobernanza y representación',
  A: 'Actores e influencia',
  D: 'Demandas y compromisos',
  N: 'Narrativas y señales digitales',
  E: 'Ambiental-territorial',
  I: 'Institucional y trazabilidad',
} as const;
export type Dimension = keyof typeof DIM_LABELS;
export const DIMENSIONS = Object.keys(DIM_LABELS) as Dimension[];

export const INDICATOR_MODULES = [
  'Eventos',
  'Actores',
  'Demandas',
  'Compromisos',
  'Narrativas',
  'Alertas',
  'Acciones',
  'Directorio_Territorial',
] as const;
export type IndicatorModule = (typeof INDICATOR_MODULES)[number];

/** A record payload plus `_id` (app.py records_of). */
export type RecordPayload = Readonly<Record<string, unknown>>;
export type ModuleRecords = Readonly<Record<IndicatorModule, readonly RecordPayload[]>>;

export type Indicator = {
  readonly code: string;
  readonly score: number | null;
  readonly confidence: string;
  readonly method: string;
  readonly evidence_count: number;
  readonly explanation: string;
  readonly availability: string;
  readonly name: string;
  readonly definition: string;
  readonly dimension: Dimension;
  readonly dimension_label: string;
};

export type IndicatorsReport = {
  readonly dimensions: Record<Dimension, Indicator[]>;
  readonly dimension_scores: Record<Dimension, number>;
  readonly availability: Record<Dimension, number>;
  readonly indicators: Indicator[];
  readonly method_note: string;
  readonly validation_status: string;
};

export const VALIDATION_STATUS = 'PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS';

const txt = (...parts: unknown[]) => parts.map(text).join(' ').toLowerCase();

const contains = (value: unknown, words: readonly string[]) => {
  const haystack = text(value).toLowerCase();
  return words.some((w) => haystack.includes(w.toLowerCase()));
};

const pct = (num: number, den: number) => (den ? pyRound((100 * num) / den, 2) : 0);

const cap = (x: number) => pyRound(Math.max(0, Math.min(100, x)), 2);

type RawIndicator = Omit<Indicator, 'name' | 'definition' | 'dimension' | 'dimension_label'>;

const ind = (
  code: string,
  score: number | null,
  confidence: string,
  method: string,
  evidenceCount: number,
  explanation: string,
  availability = 'Disponible',
): RawIndicator => ({
  code,
  score: score === null ? null : cap(score),
  confidence,
  method,
  evidence_count: Math.trunc(evidenceCount || 0),
  explanation,
  availability,
});

const DIMENSION_WORDS: readonly (readonly [string, Dimension])[] = [
  ['gobernanza', 'G'],
  ['representación', 'G'],
  ['actores', 'A'],
  ['influencia', 'A'],
  ['demandas', 'D'],
  ['compromisos', 'D'],
  ['narrativas', 'N'],
  ['digitales', 'N'],
  ['ambiental', 'E'],
  ['territorial', 'E'],
  ['institucional', 'I'],
  ['trazabilidad', 'I'],
];

/** app.py dimension_code. */
export const dimensionCode = (value: unknown): Dimension | null => {
  if (!text(value)) return null;
  const s = text(value).trim();
  const first = s[0];
  if (first && 'GADNEI'.includes(first)) return first as Dimension;
  const low = s.toLowerCase();
  return DIMENSION_WORDS.find(([word]) => low.includes(word))?.[1] ?? null;
};

const CLOSED_STATES = new Set([
  'cerrada',
  'cerrado',
  'descartada',
  'descartado',
  'cumplido',
  'cumplida',
  'cancelado',
  'cancelada',
  'atendida',
]);

/** app.py is_open_state. */
export const isOpenState = (value: unknown) => !CLOSED_STATES.has(text(value).trim().toLowerCase());

const min100 = (x: number) => Math.min(100, x);

const governance = (r: ModuleRecords): RawIndicator[] => {
  const { Actores: actores, Eventos: eventos, Narrativas: narrativas, Alertas: alertas } = r;
  const govActors = actores.filter((a) =>
    contains(txt(a['Tipo_Actor'], a['Rol/Relacion'], a['Legitimidad/Representacion']), [
      'comunal',
      'represent',
      'fundación',
      'administrador',
      'ccsms',
    ]),
  );
  const riskyLeg = govActors.filter((a) =>
    contains(a['Legitimidad/Representacion'], [
      'fragment',
      'limitad',
      'validar',
      'provisional',
      'inciert',
      'sin reconocimiento',
    ]),
  );
  const gEvents = eventos.filter((e) =>
    [dimensionCode(e['Dimension_Principal']), dimensionCode(e['Dimension_Secundaria'])].includes(
      'G',
    ),
  );
  const gHigh = gEvents.filter((e) =>
    contains(e['Relevancia_Preliminar'], ['alta', 'crít', 'crit']),
  );
  const gAlerts = alertas.filter(
    (a) => dimensionCode(a['Dimension']) === 'G' && isOpenState(a['Estado']),
  );
  const conflictWords = [
    'disputa',
    'enfrentamiento',
    'conflicto',
    'facción',
    'facciones',
    'tensión',
    'controversia',
  ];
  const gConf = gEvents.filter((e) =>
    contains(
      txt(e['Descripcion_Hecho'], e['Evidencia/Resultado'], e['Observaciones']),
      conflictWords,
    ),
  );
  const nConf = narrativas.filter((n) => contains(txt(n['Tema'], n['Descripcion']), conflictWords));
  const legalWords = [
    'judicial',
    'resolución',
    'registr',
    'sunarp',
    'bdpi',
    'consulta previa',
    'tribunal',
    'apelación',
    'fiscal',
  ];
  const legal = eventos.filter((e) =>
    contains(
      txt(e['Tipo_Evento'], e['Descripcion_Hecho'], e['Evidencia/Resultado'], e['Observaciones']),
      legalWords,
    ),
  );
  const leadWords = [
    'elección',
    'electoral',
    'padrón',
    'junta',
    'administrador',
    'liderazgo',
    'directiva',
    'empadron',
  ];
  const lead = eventos.filter((e) =>
    contains(txt(e['Tipo_Evento'], e['Descripcion_Hecho'], e['Evidencia/Resultado']), leadWords),
  );
  return [
    ind(
      'G1',
      pct(riskyLeg.length, Math.max(1, govActors.length)),
      'Media-Alta',
      'Proporción de actores de gobernanza con legitimidad/representación fragmentada, limitada o pendiente de validar.',
      govActors.length,
      `${riskyLeg.length} de ${govActors.length} actores de gobernanza presentan condiciones de representación que requieren validación.`,
    ),
    ind(
      'G2',
      min100(gHigh.length * 8 + gAlerts.length * 18),
      'Alta',
      'Suma normalizada de eventos G de relevancia alta/crítica y alertas G activas.',
      gHigh.length + gAlerts.length,
      `${gHigh.length} eventos G relevantes y ${gAlerts.length} alertas G activas.`,
    ),
    ind(
      'G3',
      min100((gConf.length + nConf.length) * 15),
      'Media-Alta',
      'Conteo normalizado de eventos y narrativas con términos de disputa/conflicto vinculados al entorno de gobernanza.',
      gConf.length + nConf.length,
      `Se identificaron ${gConf.length} eventos y ${nConf.length} narrativas con señales de conflictividad interna.`,
    ),
    ind(
      'G4',
      min100(legal.length * 12),
      'Alta',
      'Conteo normalizado de eventos con elementos judiciales, registrales, BDPI/consulta previa o apelaciones.',
      legal.length,
      `${legal.length} eventos contienen factores jurídicos/registrales relevantes.`,
    ),
    ind(
      'G5',
      min100(lead.length * 10),
      'Media-Alta',
      'Conteo normalizado de eventos relacionados con elecciones, padrón, directivas o administraciones provisionales.',
      lead.length,
      `${lead.length} eventos reflejan cambios o procesos de liderazgo/interlocución.`,
    ),
  ];
};

const actors = (r: ModuleRecords): RawIndicator[] => {
  const { Actores: actores, Eventos: eventos, Narrativas: narrativas } = r;
  const highinf = actores.filter(
    (a) =>
      contains(a['Influencia'], ['alta']) &&
      contains(a['Posicion_Proyecto'], ['crít', 'opos', 'no determinado']),
  );
  const mobil = actores.filter((a) =>
    contains(a['Capacidad_Movilizacion'], ['alta', 'media-alta']),
  );
  // Centrality proxy: concentration of actor mentions as principal actor in events.
  const mentions = new Map<string, number>();
  for (const e of eventos) {
    const actor = text(e['Actor_Principal']).trim();
    if (actor) mentions.set(actor, (mentions.get(actor) ?? 0) + 1);
  }
  const top = mentions.size ? Math.max(...mentions.values()) : 0;
  const legRisk = actores.filter((a) =>
    contains(txt(a['Legitimidad/Representacion'], a['Observaciones']), [
      'validar',
      'fragment',
      'limitad',
      'provisional',
      'inciert',
      'por confirmar',
    ]),
  );
  const polWords = [
    'polar',
    'facción',
    'alianza',
    'oposición',
    'tensión',
    'confront',
    'disputa',
    'enfrent',
  ];
  const pol = [
    ...eventos.filter((e) => contains(txt(e['Descripcion_Hecho'], e['Observaciones']), polWords)),
    ...narrativas.filter((n) => contains(txt(n['Tema'], n['Descripcion']), polWords)),
  ];
  return [
    ind(
      'A1',
      pct(highinf.length, Math.max(1, actores.length)),
      'Media-Alta',
      'Proporción de actores con influencia alta y posición crítica/opositora/no determinada.',
      actores.length,
      `${highinf.length} de ${actores.length} actores analíticos cumplen la condición de riesgo.`,
    ),
    ind(
      'A2',
      pct(mobil.length, Math.max(1, actores.length)),
      'Alta',
      'Proporción de actores con capacidad de movilización alta o media-alta.',
      actores.length,
      `${mobil.length} de ${actores.length} actores tienen capacidad de movilización relevante.`,
    ),
    // No historical actor-position series exists in the structured base.
    ind(
      'A3',
      null,
      'Baja',
      'No calculable de forma robusta: falta serie histórica estructurada de posición por actor.',
      0,
      'La base almacena una posición vigente por actor, pero no un historial suficiente para medir cambios.',
      'Datos insuficientes',
    ),
    ind(
      'A4',
      pct(top, Math.max(1, eventos.length)),
      'Media',
      'Proxy de centralidad: participación del actor más mencionado como actor principal sobre el total de eventos.',
      eventos.length,
      `El actor más mencionado concentra ${top} de ${eventos.length} eventos. Requiere reemplazo futuro por análisis de red formal.`,
    ),
    ind(
      'A5',
      pct(legRisk.length, Math.max(1, actores.length)),
      'Media',
      'Proporción de actores analíticos con legitimidad/representación pendiente, provisional o limitada.',
      actores.length,
      `${legRisk.length} de ${actores.length} actores requieren cautela de legitimidad/representación.`,
    ),
    ind(
      'A6',
      min100(pol.length * 12),
      'Media',
      'Conteo normalizado de eventos/narrativas con señales de polarización, facciones, alianzas o tensión.',
      pol.length,
      `${pol.length} registros contienen señales relacionales de polarización o tensión.`,
    ),
  ];
};

const demands = (r: ModuleRecords): RawIndicator[] => {
  const { Demandas: demandas, Compromisos: compromisos } = r;
  const openD = demandas.filter((d) => isOpenState(d['Estado']));
  const rec = demandas.filter((d) => contains(d['Recurrencia'], ['alta']));
  const overdue = compromisos.filter((c) => contains(c['Estado'], ['vencid']));
  const slow = demandas.filter((d) => contains(d['Estado'], ['nueva', 'evaluada']));
  const pend = compromisos.filter((c) => contains(c['Estado'], ['pendiente']));
  const gapWords = [
    'futuro adjudicatario',
    'por definir',
    'según etapa',
    'segun etapa',
    'según competencia',
    'segun competencia',
    'entidad competente',
    'instancia técnica',
    'instancia tecnica',
  ];
  const gap = demandas.filter((d) =>
    contains(txt(d['Entidad_Competente'], d['Observaciones']), gapWords),
  );
  return [
    ind(
      'D1',
      min100(openD.length * 7),
      'Alta',
      'Número de demandas abiertas normalizado a 0–100.',
      openD.length,
      `${openD.length} demandas permanecen abiertas o no cerradas.`,
    ),
    ind(
      'D2',
      pct(rec.length, Math.max(1, demandas.length)),
      'Alta',
      'Porcentaje de demandas con recurrencia alta.',
      demandas.length,
      `${rec.length} de ${demandas.length} demandas están marcadas con recurrencia alta.`,
    ),
    ind(
      'D3',
      pct(overdue.length, Math.max(1, compromisos.length)),
      'Alta',
      'Porcentaje de compromisos en estado vencido.',
      compromisos.length,
      `${overdue.length} de ${compromisos.length} compromisos están vencidos según el registro actual.`,
    ),
    ind(
      'D4',
      min100((slow.length + pend.length) * 10),
      'Baja-Media',
      'Proxy por demandas en estado inicial y compromisos pendientes. No sustituye un cálculo de días de respuesta.',
      slow.length + pend.length,
      `${slow.length} demandas están en estados iniciales y ${pend.length} compromisos están pendientes.`,
      'Proxy por datos incompletos',
    ),
    ind(
      'D5',
      pct(gap.length, Math.max(1, demandas.length)),
      'Media-Alta',
      'Proporción de demandas cuya atención depende de futura etapa, entidad o competencia por precisar.',
      demandas.length,
      `${gap.length} de ${demandas.length} demandas presentan brecha expectativa–competencia/etapa.`,
    ),
  ];
};

const narratives = (r: ModuleRecords): RawIndicator[] => {
  const narrativas = r.Narrativas;
  const n = Math.max(1, narrativas.length);
  const critical = narrativas.filter(
    (x) => contains(x['Tono'], ['negativo']) && contains(x['Intensidad'], ['alta']),
  );
  const activeN = narrativas.filter((x) => isOpenState(x['Estado']));
  const digConfWords = [
    'controvers',
    'conflicto',
    'tensión',
    'disputa',
    'enfrent',
    'polar',
    'cuestion',
  ];
  const digConf = narrativas.filter((x) =>
    contains(txt(x['Tema'], x['Descripcion']), digConfWords),
  );
  const unver = narrativas.filter(
    (x) =>
      contains(x['Nivel_Verificacion'], ['e -', 'no verificada']) ||
      contains(x['Nivel_Verificacion'], ['d - opinión', 'd - opinion']),
  );
  const themes = new Set(
    narrativas.map((x) => text(x['Tema']).trim().toLowerCase()).filter((t) => t !== ''),
  );
  return [
    ind(
      'N1',
      pct(critical.length, n),
      'Alta',
      'Porcentaje de narrativas con tono negativo e intensidad alta.',
      narrativas.length,
      `${critical.length} de ${narrativas.length} narrativas cumplen el criterio de contenido crítico.`,
    ),
    ind(
      'N2',
      pct(activeN.length, n),
      'Media',
      'Proporción de narrativas que permanecen en seguimiento/activas. Es un proxy de persistencia, no una tasa temporal.',
      narrativas.length,
      `${activeN.length} de ${narrativas.length} narrativas permanecen abiertas/en seguimiento.`,
      'Proxy temporal',
    ),
    ind(
      'N3',
      pct(digConf.length, n),
      'Media-Alta',
      'Porcentaje de narrativas con términos asociados a confrontación o controversia.',
      narrativas.length,
      `${digConf.length} de ${narrativas.length} narrativas muestran señales de confrontación/controversia.`,
    ),
    ind(
      'N4',
      pct(unver.length, n),
      'Alta',
      'Porcentaje de narrativas clasificadas como opinión/narrativa o no verificadas.',
      narrativas.length,
      `${unver.length} de ${narrativas.length} narrativas requieren cautela de verificación.`,
    ),
    ind(
      'N5',
      min100(themes.size * 12),
      'Baja-Media',
      'Número de temas distintos normalizado como proxy de diversificación de la agenda narrativa.',
      themes.size,
      `El monitoreo registra ${themes.size} temas distintos. Se requiere una serie temporal mayor para identificar emergencia real.`,
      'Proxy por serie limitada',
    ),
  ];
};

const LIVELIHOODS: readonly (readonly [string, readonly string[]])[] = [
  ['pesca', ['pesca', 'pescador']],
  ['maricultura', ['maricult']],
  ['ganadería', ['ganad']],
  ['agricultura', ['agric']],
  ['transporte', ['transport']],
];

const environment = (r: ModuleRecords): RawIndicator[] => {
  const { Demandas: demandas, Eventos: eventos } = r;
  const envWords = [
    'agua',
    'pesca',
    'maricultura',
    'ambient',
    'territor',
    'servid',
    'biodivers',
    'pozo',
    'ganad',
    'agric',
    'polvo',
    'bahía',
    'bahia',
    'tránsito',
    'transito',
  ];
  const envDem = demandas.filter(
    (d) =>
      dimensionCode(d['Dimension']) === 'E' || contains(txt(d['Tema'], d['Descripcion']), envWords),
  );
  const envEvt = eventos.filter(
    (e) =>
      [dimensionCode(e['Dimension_Principal']), dimensionCode(e['Dimension_Secundaria'])].includes(
        'E',
      ) || contains(e['Descripcion_Hecho'], envWords),
  );
  const activeEnvDem = envDem.filter((d) => isOpenState(d['Estado']));
  const envRec = envDem.filter((d) => contains(d['Recurrencia'], ['alta']));
  const corpus =
    demandas.map((d) => txt(d['Actor/Grupo'], d['Tema'], d['Descripcion'])).join(' ') +
    ' ' +
    eventos.map((e) => txt(e['Actor_Principal'], e['Descripcion_Hecho'])).join(' ');
  const exposed = LIVELIHOODS.filter(([, words]) => contains(corpus, words)).map(([s]) => s);
  const terrWords = [
    'territorio',
    'servidumbre',
    'tránsito',
    'transito',
    'superficie',
    'acceso',
    'delimitación',
    'delimitacion',
    'ruta',
    'pozo hierba blanca',
  ];
  const terr = [...demandas, ...eventos].filter((x) =>
    contains(
      txt(x['Tema'], x['Descripcion'], x['Descripcion_Hecho'], x['Observaciones']),
      terrWords,
    ),
  );
  const envVerified = envEvt.filter((e) => contains(e['Nivel_Verificacion'], ['a -', 'b -']));
  const envPerceived = envEvt.filter((e) =>
    contains(e['Nivel_Verificacion'], ['c -', 'd -', 'e -']),
  );
  return [
    ind(
      'E1',
      min100(activeEnvDem.length * 8 + envEvt.length * 4),
      'Alta',
      'Suma normalizada de demandas ambientales abiertas y eventos ambientales/territoriales.',
      activeEnvDem.length + envEvt.length,
      `${activeEnvDem.length} demandas ambientales abiertas y ${envEvt.length} eventos relacionados.`,
    ),
    ind(
      'E2',
      pct(envRec.length, Math.max(1, envDem.length)),
      'Alta',
      'Porcentaje de demandas ambientales/territoriales con recurrencia alta.',
      envDem.length,
      `${envRec.length} de ${envDem.length} demandas ambientales son recurrentes.`,
    ),
    ind(
      'E3',
      min100(exposed.length * 18),
      'Media-Alta',
      'Diversidad de medios de vida identificados en demandas/eventos, normalizada a 0–100.',
      exposed.length,
      `Se identifican ${exposed.length} sectores: ${exposed.length ? exposed.join(', ') : 'ninguno estructurado'}.`,
    ),
    ind(
      'E4',
      min100(terr.length * 10),
      'Alta',
      'Conteo normalizado de registros con uso de territorio, servidumbres, accesos, rutas o delimitación.',
      terr.length,
      `${terr.length} registros contienen asuntos de territorio/acceso/servidumbre.`,
    ),
    ind(
      'E5',
      pct(envPerceived.length, Math.max(1, envVerified.length + envPerceived.length)),
      'Media-Alta',
      'Porcentaje de eventos ambientales sustentados en percepción/opinión/no verificado frente al total ambiental con nivel de verificación.',
      envVerified.length + envPerceived.length,
      `${envPerceived.length} eventos ambientales se basan en percepción/opinión y ${envVerified.length} están verificados/corroborados.`,
    ),
  ];
};

const OPEN_ACTION = ['pendiente', 'en curso', 'vencid'];

const institutional = (r: ModuleRecords): RawIndicator[] => {
  const { Alertas: alertas, Acciones: acciones, Eventos: eventos, Demandas: demandas } = r;
  const iAlerts = alertas.filter(
    (a) => dimensionCode(a['Dimension']) === 'I' && isOpenState(a['Estado']),
  );
  const alertMap = new Map(
    alertas.map((a) => [
      pyStr(firstTruthy(a['ID_Alerta'], a['_id'])),
      dimensionCode(a['Dimension']),
    ]),
  );
  const iActions = acciones.filter(
    (a) => alertMap.get(text(a['ID_Alerta'])) === 'I' && contains(a['Estado'], OPEN_ACTION),
  );
  const msgWords = [
    'contradic',
    'desinform',
    'precisar',
    'aclar',
    'carácter informativo',
    'caracter informativo',
    'alcance',
    'no asumir',
  ];
  const msg = eventos.filter(
    (e) =>
      dimensionCode(e['Dimension_Principal']) === 'I' ||
      dimensionCode(e['Dimension_Secundaria']) === 'I',
  );
  const msgRisk = msg.filter((e) =>
    contains(txt(e['Descripcion_Hecho'], e['Evidencia/Resultado'], e['Observaciones']), msgWords),
  );
  const openActions = acciones.filter((a) => contains(a['Estado'], OPEN_ACTION)).length;
  const activeAlerts = alertas.filter((a) => isOpenState(a['Estado']));
  const noresp = activeAlerts.filter(
    (a) => !text(a['Responsable']).trim() || contains(a['Responsable'], ['por asignar']),
  );
  const keyRecords = [...eventos, ...demandas, ...alertas, ...acciones, ...r.Narrativas];
  const withSource = keyRecords.filter((x) => {
    const evidence = firstTruthy(x['Evidencia'], x['Evidencia/Resultado'], x['Evidencia_Cierre']);
    return text(x['Fuente_ID']).trim() !== '' || text(evidence).trim() !== '';
  });
  const completeness = pct(withSource.length, Math.max(1, keyRecords.length));
  const territories = new Set(
    [...eventos, ...demandas]
      .map((x) => text(x['Territorio']).trim())
      .filter((t) => t !== '')
      .map((t) => t.toLowerCase()),
  );
  // Directory: conservative reference of distinct territorial sections when available.
  const dirPlaces = new Set(
    r.Directorio_Territorial.map((x) =>
      text(firstTruthy(x['Sección territorial'], x['Lugar / ámbito'])).trim(),
    )
      .filter((t) => t !== '')
      .map((t) => t.toLowerCase()),
  );
  const denom = Math.max(1, dirPlaces.size || territories.size);
  const coveragePct = pct(territories.size, denom);
  // Python min(100, x) keeps the int 100 when x >= 100, which changes its text form.
  const coverage = Math.min(100, coveragePct);
  const coverageText = coveragePct >= 100 ? '100' : pyFloat(coverage);
  return [
    ind(
      'I1',
      min100(iAlerts.length * 18 + iActions.length * 8),
      'Media-Alta',
      'Alertas institucionales activas y acciones institucionales pendientes como proxy de coordinación residual.',
      iAlerts.length + iActions.length,
      `${iAlerts.length} alertas I activas y ${iActions.length} acciones I pendientes/en curso.`,
    ),
    ind(
      'I2',
      pct(msgRisk.length, Math.max(1, msg.length)),
      'Media',
      'Porcentaje de eventos institucionales que requieren precisión, aclaración o cautela de mensaje.',
      msg.length,
      `${msgRisk.length} de ${msg.length} eventos institucionales presentan señales de coherencia/mensaje por gestionar.`,
    ),
    ind(
      'I3',
      min100(iAlerts.length * 12 + openActions * 4),
      'Baja-Media',
      'Proxy basado en alertas institucionales activas y acciones abiertas. No es un cálculo de días de respuesta.',
      iAlerts.length + openActions,
      `${iAlerts.length} alertas I activas y ${openActions} acciones generales abiertas.`,
      'Proxy por fechas incompletas',
    ),
    ind(
      'I4',
      pct(noresp.length, Math.max(1, activeAlerts.length)),
      'Alta',
      "Porcentaje de alertas activas sin responsable definido o marcadas 'Por asignar'.",
      activeAlerts.length,
      `${noresp.length} de ${activeAlerts.length} alertas activas no tienen responsable efectivo.`,
    ),
    ind(
      'I5',
      100 - completeness,
      'Alta',
      'Riesgo inverso del porcentaje de registros clave con Fuente_ID o evidencia asociada.',
      keyRecords.length,
      `${withSource.length} de ${keyRecords.length} registros clave cuentan con fuente/evidencia estructurada (${pyFloat(completeness)}%).`,
    ),
    ind(
      'I6',
      100 - coverage,
      'Media',
      'Riesgo inverso de la cobertura: territorios presentes en eventos/demandas frente a ámbitos diferenciados del directorio.',
      territories.size,
      `Se cubren ${territories.size} territorios en registros operativos frente a ${denom} ámbitos de referencia; cobertura estimada ${coverageText}%.`,
      'Indicador de cobertura aproximada',
    ),
  ];
};

const RULES: Record<Dimension, (r: ModuleRecords) => RawIndicator[]> = {
  G: governance,
  A: actors,
  D: demands,
  N: narratives,
  E: environment,
  I: institutional,
};

/** app.py compute_indicators: indicator scores, metadata and per-dimension aggregation. */
export const computeIndicators = (
  records: ModuleRecords,
  meta: Readonly<Record<string, readonly IndicatorMeta[]>> = INDICATOR_CONFIG,
): IndicatorsReport => {
  const dimensions = {} as Record<Dimension, Indicator[]>;
  const dimensionScores = {} as Record<Dimension, number>;
  const availability = {} as Record<Dimension, number>;
  const flat: Indicator[] = [];
  for (const d of DIMENSIONS) {
    const raw = RULES[d](records);
    const metaBy = new Map((meta[d] ?? []).map((m) => [m.code, m]));
    const available = raw.flatMap((x) => (x.score === null ? [] : [x.score]));
    dimensionScores[d] = available.length
      ? pyRound(available.reduce((a, b) => a + b, 0) / available.length, 2)
      : 0;
    availability[d] = raw.length ? pyRound((100 * available.length) / raw.length, 1) : 0;
    dimensions[d] = raw.map((x) => {
      const m = metaBy.get(x.code);
      const indicator = {
        ...x,
        ...(m ? { code: m.code, name: m.name, definition: m.definition } : {}),
        dimension: d,
        dimension_label: DIM_LABELS[d],
      } as Indicator;
      flat.push(indicator);
      return indicator;
    });
  }
  return {
    dimensions,
    dimension_scores: dimensionScores,
    availability,
    indicators: flat,
    method_note:
      'V0.4 usa reglas/proxies transparentes. Indicadores con datos insuficientes se excluyen del promedio dimensional.',
    validation_status: VALIDATION_STATUS,
  };
};
