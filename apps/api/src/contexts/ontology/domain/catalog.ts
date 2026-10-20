/**
 * The MASCLI ontology (docs/adr/0011): which territorial records are objects, how they are
 * named, and which typed links may join them. Payloads stay free-form; this catalog is the
 * semantic layer every view (links, search, graph, briefings) reads.
 */

export type ObjectType = {
  /** URL slug used by /api/{module}. */
  readonly slug: string;
  /** Stored module name in module_records. */
  readonly module: string;
  readonly label: string;
  readonly titleField: string;
  /** Extra fields that summarize a record in lists, search hits and briefings. */
  readonly summaryFields: readonly string[];
  /** Field holding the record's own date, when it has one (ISO yyyy-mm-dd). */
  readonly dateField: string | null;
};

const type = (
  slug: string,
  module: string,
  label: string,
  titleField: string,
  summaryFields: readonly string[],
  dateField: string | null = null,
): ObjectType => ({ slug, module, label, titleField, summaryFields, dateField });

export const OBJECT_TYPES: readonly ObjectType[] = [
  type('actores', 'Actores', 'Actor', 'Nombre_Actor/Organizacion', [
    'Tipo_Actor',
    'Posicion_Proyecto',
    'Influencia',
    'Territorio',
  ]),
  type(
    'eventos',
    'Eventos',
    'Evento',
    'Descripcion_Hecho',
    ['Tipo_Evento', 'Territorio', 'Relevancia_Preliminar', 'Estado_Validacion'],
    'Fecha',
  ),
  type(
    'demandas',
    'Demandas',
    'Demanda',
    'Descripcion',
    ['Actor/Grupo', 'Tema', 'Prioridad', 'Estado'],
    'Fecha_Registro',
  ),
  type(
    'compromisos',
    'Compromisos',
    'Compromiso',
    'Descripcion',
    ['Actor/Entidad', 'Responsable', 'Plazo', 'Avance_%', 'Estado'],
    'Fecha',
  ),
  type(
    'narrativas',
    'Narrativas',
    'Narrativa',
    'Descripcion',
    ['Plataforma/Fuente', 'Tema', 'Tono', 'Estado'],
    'Fecha_Observacion',
  ),
  type(
    'fuentes',
    'Fuentes',
    'Fuente',
    'Archivo_Fuente',
    ['Tipo_Fuente', 'Institucion/Autor', 'Nivel_Base_Verificacion'],
    'Fecha_Documento',
  ),
  type(
    'alertas',
    'Alertas',
    'Alerta',
    'Causa',
    ['Dimension', 'Nivel_Preliminar', 'Estado'],
    'Fecha',
  ),
  type('acciones', 'Acciones', 'Acción', 'Accion', ['Responsable', 'Plazo', 'Estado']),
  type('directorio', 'Directorio_Territorial', 'Contacto', 'Nombre', [
    'Cargo',
    'Institucion',
    'Prioridad',
  ]),
  type('intereses', 'Intereses', 'Interés', 'Actor', ['Posicion', 'Interes', 'Estado']),
  type('dialogos', 'Dialogos', 'Diálogo', 'Proceso', ['Tema', 'Acuerdo', 'Proximo_Paso', 'Estado']),
  type('oportunidades', 'Oportunidades', 'Oportunidad', 'Oportunidad', [
    'Tipo',
    'Beneficiarios',
    'Viabilidad',
    'Estado',
  ]),
  type('hechos', 'Hechos_Compartidos', 'Hecho compartido', 'Asunto', [
    'Metodo',
    'Accion_Verificacion',
    'Estado',
  ]),
  type(
    'aarc',
    'Evaluaciones_AARC',
    'Evaluación AARC',
    'Actor_Proceso',
    ['Accion_Mejora', 'Estado'],
    'Fecha',
  ),
  type('buzon', 'Buzon', 'Caso del buzón', 'Asunto', ['Tipo', 'Territorio', 'Estado'], 'Fecha'),
];

const BY_SLUG = new Map(OBJECT_TYPES.map((t) => [t.slug, t]));
const BY_MODULE = new Map(OBJECT_TYPES.map((t) => [t.module, t]));

export const objectTypeForSlug = (slug: string) => BY_SLUG.get(slug) ?? null;
export const objectTypeForModule = (module: string) => BY_MODULE.get(module) ?? null;

export type LinkType = {
  readonly id: string;
  /** Reads source → target, e.g. "participa en". */
  readonly label: string;
  /** Reads target → source, e.g. "tiene como participante a". */
  readonly inverseLabel: string;
  /** Allowed source and target slugs; `null` accepts every object type. */
  readonly sources: readonly string[] | null;
  readonly targets: readonly string[] | null;
  /** A symmetric link reads the same both ways and is stored once. */
  readonly symmetric: boolean;
};

const link = (
  id: string,
  label: string,
  inverseLabel: string,
  sources: readonly string[] | null,
  targets: readonly string[] | null,
  symmetric = false,
): LinkType => ({ id, label, inverseLabel, sources, targets, symmetric });

export const LINK_TYPES: readonly LinkType[] = [
  link(
    'participa_en',
    'participa en',
    'tiene como participante a',
    ['actores'],
    ['eventos', 'dialogos'],
  ),
  link('plantea', 'plantea', 'es planteada por', ['actores'], ['demandas']),
  link('asume', 'asume', 'es asumido por', ['actores'], ['compromisos']),
  link(
    'responde_a',
    'responde a',
    'es atendida por',
    ['compromisos', 'acciones', 'oportunidades'],
    ['demandas'],
  ),
  link('difunde', 'difunde', 'es difundida por', ['actores'], ['narrativas']),
  link('sustenta', 'sustenta', 'se sustenta en', ['fuentes'], null),
  link('origina', 'origina', 'se origina en', ['eventos', 'narrativas', 'demandas'], ['alertas']),
  link('atiende', 'atiende', 'es atendida por', ['acciones'], ['alertas']),
  link('representa_a', 'representa a', 'es representado por', ['directorio'], ['actores']),
  link('aliado_de', 'es aliado de', 'es aliado de', ['actores'], ['actores'], true),
  link(
    'en_conflicto_con',
    'está en conflicto con',
    'está en conflicto con',
    ['actores'],
    ['actores'],
    true,
  ),
  link('relacionado_con', 'está relacionado con', 'está relacionado con', null, null, true),
];

const LINKS = new Map(LINK_TYPES.map((t) => [t.id, t]));
export const linkTypeById = (id: string) => LINKS.get(id) ?? null;

const accepts = (allowed: readonly string[] | null, slug: string) =>
  allowed === null || allowed.includes(slug);

export type LinkProblem = 'unknown_type' | 'unknown_object' | 'self_link' | 'not_allowed';

/** Checks a proposed link against the catalog; symmetric types accept either order. */
export const checkLink = (
  linkTypeId: string,
  source: { slug: string; id: string },
  target: { slug: string; id: string },
): LinkProblem | null => {
  const linkType = linkTypeById(linkTypeId);
  if (!linkType) return 'unknown_type';
  if (!objectTypeForSlug(source.slug) || !objectTypeForSlug(target.slug)) return 'unknown_object';
  if (source.slug === target.slug && source.id === target.id) return 'self_link';
  const forward = accepts(linkType.sources, source.slug) && accepts(linkType.targets, target.slug);
  const backward =
    linkType.symmetric &&
    accepts(linkType.sources, target.slug) &&
    accepts(linkType.targets, source.slug);
  return forward || backward ? null : 'not_allowed';
};

/**
 * Links read from reference fields already present in payloads. `field` lives on the
 * `holder` record and points at a `target` record by id or by its title (entity resolution
 * by exact, case-insensitive name). `holderIsSource` says which end the link starts from.
 */
export type InferenceRule = {
  readonly linkType: string;
  readonly holder: string;
  readonly field: string;
  readonly target: string;
  readonly match: 'id' | 'title';
  readonly holderIsSource: boolean;
};

const ALL_WITH_SOURCE_FIELD = [
  'eventos',
  'actores',
  'directorio',
  'demandas',
  'compromisos',
  'narrativas',
  'alertas',
  'acciones',
  'intereses',
  'dialogos',
  'oportunidades',
  'hechos',
];

export const INFERENCE_RULES: readonly InferenceRule[] = [
  ...ALL_WITH_SOURCE_FIELD.map((holder): InferenceRule => ({
    linkType: 'sustenta',
    holder,
    field: 'Fuente_ID',
    target: 'fuentes',
    match: 'id',
    holderIsSource: false,
  })),
  {
    linkType: 'atiende',
    holder: 'acciones',
    field: 'Alerta_Asociada',
    target: 'alertas',
    match: 'id',
    holderIsSource: true,
  },
  {
    linkType: 'responde_a',
    holder: 'compromisos',
    field: 'Demanda_Asociada',
    target: 'demandas',
    match: 'id',
    holderIsSource: true,
  },
  {
    linkType: 'participa_en',
    holder: 'eventos',
    field: 'Actor_Principal',
    target: 'actores',
    match: 'title',
    holderIsSource: false,
  },
  {
    linkType: 'plantea',
    holder: 'demandas',
    field: 'Actor/Grupo',
    target: 'actores',
    match: 'title',
    holderIsSource: false,
  },
  {
    linkType: 'asume',
    holder: 'compromisos',
    field: 'Actor/Entidad',
    target: 'actores',
    match: 'title',
    holderIsSource: false,
  },
  {
    linkType: 'difunde',
    holder: 'narrativas',
    field: 'Actor_Relacionado',
    target: 'actores',
    match: 'title',
    holderIsSource: false,
  },
  {
    linkType: 'relacionado_con',
    holder: 'intereses',
    field: 'Actor',
    target: 'actores',
    match: 'title',
    holderIsSource: true,
  },
];

/** Short readable title of a record: its title field, else its id. */
export const titleOf = (
  objectType: ObjectType,
  id: string,
  payload: Readonly<Record<string, unknown>>,
) => {
  const value = payload[objectType.titleField];
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return text ? (text.length > 140 ? `${text.slice(0, 139)}…` : text) : id;
};

/** Classification markings, least to most sensitive (docs/adr/0012). */
export const MARKINGS = ['publico', 'interno', 'restringido'] as const;
export type Marking = (typeof MARKINGS)[number];
export const isMarking = (value: string): value is Marking =>
  (MARKINGS as readonly string[]).includes(value);
