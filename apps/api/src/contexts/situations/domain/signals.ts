/**
 * Records as dated signals (docs/adr/0020 §2). Pure: no I/O. Territory comes only from the
 * record's own territory fields, never from its text.
 */

export type SourceRecord = {
  readonly module: string;
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type Signal = {
  readonly module: string;
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly ageDays: number;
  /** 1 normal, 1.5 high, 2 critical, from the record's own level or priority. */
  readonly severity: number;
  readonly topics: readonly string[];
  readonly actors: readonly string[];
  readonly territory: string | null;
  /** Narratives only: the recorded tone, folded. */
  readonly tone: string | null;
};

type ModuleSpec = {
  readonly dates: readonly string[];
  readonly titles: readonly string[];
  readonly actors: readonly string[];
  readonly topics: readonly string[];
  readonly severity: readonly string[];
  readonly text: readonly string[];
};

/** Modules that can form situations, with the fields each one carries. */
export const MODULE_SPECS: Readonly<Record<string, ModuleSpec>> = {
  Eventos: {
    dates: ['Fecha'],
    titles: ['Descripcion_Hecho', 'Tipo_Evento'],
    actors: ['Actor_Principal'],
    topics: ['Tema', 'Tipo_Evento'],
    severity: ['Relevancia_Preliminar', 'Nivel_Preliminar'],
    text: ['Descripcion_Hecho', 'Tipo_Evento', 'Observaciones'],
  },
  Demandas: {
    dates: ['Fecha_Registro', 'Fecha'],
    titles: ['Tema', 'Descripcion'],
    actors: ['Actor/Grupo'],
    topics: ['Tema'],
    severity: ['Prioridad'],
    text: ['Tema', 'Descripcion'],
  },
  Compromisos: {
    dates: ['Fecha'],
    titles: ['Descripcion'],
    actors: ['Actor/Entidad', 'Responsable'],
    topics: ['Tema'],
    severity: ['Prioridad'],
    text: ['Descripcion'],
  },
  Narrativas: {
    dates: ['Fecha_Inicio', 'Fecha_Observacion'],
    titles: ['Tema', 'Descripcion'],
    actors: ['Actor_Relacionado'],
    topics: ['Tema'],
    severity: ['Intensidad'],
    text: ['Tema', 'Descripcion'],
  },
  Alertas: {
    dates: ['Fecha'],
    titles: ['Causa'],
    actors: ['Actor', 'Actor_Relacionado'],
    topics: ['Tema'],
    severity: ['Nivel_Preliminar', 'Nivel'],
    text: ['Causa', 'Accion_Sugerida'],
  },
  Dialogos: {
    dates: ['Fecha'],
    titles: ['Proceso', 'Tema'],
    actors: ['Participantes'],
    topics: ['Tema'],
    severity: [],
    text: ['Tema', 'Acuerdo'],
  },
  Buzon: {
    dates: ['Fecha'],
    titles: ['Asunto', 'Descripcion'],
    actors: ['Actor_Relacionado'],
    topics: ['Tema'],
    severity: ['Prioridad'],
    text: ['Asunto', 'Descripcion'],
  },
};

export const TERRITORY_FIELDS = ['Territorio', 'Comunidad', 'Localidad', 'Distrito'] as const;

/** Alerts that MASCLI 4.0 itself suggested never feed new situations (no self-reinforcement). */
export const GENERATED_ORIGIN = 'MASCLI 4.0';

/** A short, visible keyword list; a record's own topic field always counts as well. */
export const TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  'Empleo local': ['empleo', 'trabajo', 'mano de obra', 'contratacion', 'puestos'],
  Agua: ['agua', 'hidric', 'pozo', 'riego', 'manantial'],
  'Medio ambiente': ['ambiental', 'contamina', 'polvo', 'relave', 'derrame', 'emision'],
  'Tierras y territorio': ['tierra', 'terreno', 'servidumbre', 'posesion', 'linder'],
  'Compromisos y beneficios': ['compromiso', 'convenio', 'beneficio', 'aporte'],
  'Proveedores locales': ['proveedor', 'compras locales'],
  Salud: ['salud', 'enfermedad', 'posta'],
  Movilización: ['paro', 'bloqueo', 'protesta', 'marcha', 'movilizacion', 'huelga'],
  'Participación y consulta': ['consulta previa', 'participacion', 'asamblea', 'audiencia'],
  'Gobernanza comunal': ['directiva', 'eleccion', 'junta', 'representacion', 'padron'],
  Seguridad: ['violencia', 'enfrentamiento', 'agresion', 'amenaza', 'detenid'],
  'Canon y regalías': ['canon', 'regalia'],
};

export const fold = (value: unknown) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

export const first = (payload: SourceRecord['payload'], keys: readonly string[]) => {
  for (const key of keys) {
    const value = text(payload[key]);
    if (value) return value;
  }
  return '';
};

/** `YYYY-MM-DD` from ISO or `dd/mm/yyyy`; null when the record has no usable date. */
export const dayOf = (value: string): string | null => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  const day = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : local
      ? `${local[3]}-${local[2]?.padStart(2, '0')}-${local[1]?.padStart(2, '0')}`
      : null;
  if (!day) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : day;
};

const DAY_MS = 86_400_000;
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const severityOf = (value: string) => {
  const v = fold(value);
  if (/rojo|critic|muy alta/.test(v)) return 2;
  if (/naranja|alta|alto/.test(v)) return 1.5;
  return 1;
};

const hasWord = (haystack: string, word: string) =>
  new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack);

/** Topic names of a record: its topic fields (mapped to a known topic when they match) and keywords. */
export const topicsOf = (payload: SourceRecord['payload'], spec: ModuleSpec) => {
  const found = new Set<string>();
  const known = (value: string) =>
    Object.entries(TOPIC_KEYWORDS).filter(([, words]) => words.some((w) => hasWord(value, w)));
  for (const key of spec.topics) {
    const value = text(payload[key]);
    if (!value) continue;
    const matches = known(fold(value));
    if (matches.length) for (const [name] of matches) found.add(name);
    else found.add(value.charAt(0).toUpperCase() + value.slice(1));
  }
  const body = fold(spec.text.map((key) => text(payload[key])).join(' '));
  for (const [name] of known(body)) found.add(name);
  return [...found];
};

/** Names in actor fields; lists separated by commas or semicolons count one by one. */
export const actorsOf = (payload: SourceRecord['payload'], spec: ModuleSpec) => {
  const names = new Map<string, string>();
  for (const key of spec.actors) {
    for (const part of text(payload[key]).split(/[;,]/)) {
      const name = part.trim();
      if (name.length > 1 && !names.has(fold(name))) names.set(fold(name), name);
    }
  }
  return [...names.values()];
};

export const territoryOf = (payload: SourceRecord['payload']) =>
  first(payload, TERRITORY_FIELDS) || null;

/** The record as a signal, `undated` when it has no usable date, null when it never counts. */
export const toSignal = (record: SourceRecord, today: string): Signal | 'undated' | null => {
  const spec = MODULE_SPECS[record.module];
  if (!spec) return null;
  const { payload } = record;
  if (record.module === 'Alertas' && text(payload.Origen) === GENERATED_ORIGIN) return null;
  const day = dayOf(first(payload, spec.dates));
  if (!day) return 'undated';
  const age = daysBetween(day, today);
  if (age < 0) return null;
  const title = first(payload, spec.titles) || record.id;
  return {
    module: record.module,
    id: record.id,
    title: title.length > 120 ? `${title.slice(0, 117)}…` : title,
    date: day,
    ageDays: age,
    severity: severityOf(first(payload, spec.severity)),
    topics: topicsOf(payload, spec),
    actors: actorsOf(payload, spec),
    territory: territoryOf(payload),
    tone: record.module === 'Narrativas' ? fold(payload.Tono) || null : null,
  };
};
