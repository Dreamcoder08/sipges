/** URL slug → stored module name (app.py MODULES). */
const MODULES = {
  eventos: 'Eventos',
  actores: 'Actores',
  demandas: 'Demandas',
  compromisos: 'Compromisos',
  narrativas: 'Narrativas',
  fuentes: 'Fuentes',
  indicadores: 'Indicadores',
  alertas: 'Alertas',
  acciones: 'Acciones',
  directorio: 'Directorio_Territorial',
  priorizados: 'Actores_Priorizados',
  usuarios: 'Usuarios',
  roles: 'Roles',
  proyectos: 'Proyectos',
  intereses: 'Intereses',
  dialogos: 'Dialogos',
  oportunidades: 'Oportunidades',
  hechos: 'Hechos_Compartidos',
  aarc: 'Evaluaciones_AARC',
  // MASCLI 4.0 complaints, reports, questions and suggestions (docs/adr/0020).
  buzon: 'Buzon',
} as const;

export type ModuleName = (typeof MODULES)[keyof typeof MODULES];

/** Payload field that carries the caller-chosen record id (app.py rid_for). */
const ID_KEYS: Partial<Record<ModuleName, string>> = {
  Eventos: 'ID_Evento',
  Actores: 'ID_Actor',
  Demandas: 'ID_Demanda',
  Compromisos: 'ID_Compromiso',
  Narrativas: 'ID_Narrativa',
  Fuentes: 'ID_Fuente',
  Indicadores: 'Codigo',
  Alertas: 'ID_Alerta',
  Acciones: 'ID_Accion',
  Usuarios: 'ID_Usuario',
  Roles: 'ID_Rol',
  Proyectos: 'Proyecto_ID',
  Buzon: 'ID_Caso',
};

const PREFIXES: Partial<Record<ModuleName, string>> = {
  Eventos: 'EV',
  Actores: 'A',
  Demandas: 'D',
  Alertas: 'AL',
  Fuentes: 'F',
  Usuarios: 'USR',
  Roles: 'ROL',
  Proyectos: 'PRJ',
  Buzon: 'BZ',
};

export const MAX_RECORD_ID = 200;

export type Payload = Readonly<Record<string, unknown>>;

/** Every module as slug and stored name, in menu order. */
export const RECORD_MODULES: readonly { readonly slug: string; readonly module: ModuleName }[] =
  Object.entries(MODULES).map(([slug, module]) => ({ slug, module }));

export const moduleForSlug = (slug: string): ModuleName | null =>
  Object.hasOwn(MODULES, slug) ? MODULES[slug as keyof typeof MODULES] : null;

/** A path id that can never be stored (NUL or over-long) is simply not found. */
export const isLookupableId = (id: string) => id.length <= MAX_RECORD_ID && !id.includes('\u0000');

/** Per-module rule: the id field, when present, must be a usable scalar. */
export const validatePayload = (
  module: ModuleName,
  payload: Payload,
): { field: string; message: string } | null => {
  const key = ID_KEYS[module];
  const value = key ? payload[key] : undefined;
  if (!key || value === undefined || value === null || value === '') return null;
  const scalar = typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
  return scalar && String(value).length <= MAX_RECORD_ID
    ? null
    : {
        field: key,
        message: `${key} must be a string or number of at most ${MAX_RECORD_ID} characters`,
      };
};

/** app.py rid_for: the module id field when truthy, otherwise `<prefix>-<8 hex>`. */
export const recordIdFor = (
  module: ModuleName,
  payload: Payload,
  randomHex: (n: number) => string,
) => {
  const key = ID_KEYS[module];
  const value = key ? payload[key] : undefined;
  if (value !== undefined && value !== null && value !== '' && value !== 0) return String(value);
  const prefix = PREFIXES[module] ?? module.slice(0, 3).toUpperCase();
  return `${prefix}-${randomHex(8)}`;
};

/** Second attempt after an id collision: `<id>-<4 hex>`. */
export const collisionId = (id: string, randomHex: (n: number) => string) =>
  `${id}-${randomHex(4)}`;

/** Projects carry their own id inside the payload (app.py create_record). */
export const withAssignedId = (module: ModuleName, payload: Payload, id: string): Payload =>
  module === 'Proyectos' ? { ...payload, Proyecto_ID: id } : payload;
