import { pyGet, pyTruthy } from './python.ts';

/** A module record as persisted: its id and JSON payload. */
export type StoredRecord = {
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** Records of each module, newest first (app.py `ORDER BY updated_at DESC`). */
export type RecordsByModule = Readonly<Record<string, readonly StoredRecord[]>>;

/** A payload with its record id under `_id`, as app.py engines see it. */
export type AnalysisRecord = Readonly<Record<string, unknown>> & { readonly _id: string };

/** Legacy project of the Python installation: records without Proyecto_ID belong to it. */
export const DEFAULT_PROJECT_ID = 'PRJ-SECHURA';

export const SITUATIONAL_MODULES = [
  'Eventos',
  'Actores',
  'Demandas',
  'Compromisos',
  'Narrativas',
  'Alertas',
  'Acciones',
  'Fuentes',
] as const;

/** app.py EXTENDED_MODULES (RC 1.7 second layer), in its key order. */
export const EXTENDED_MODULES = {
  intereses: 'Intereses',
  dialogos: 'Dialogos',
  oportunidades: 'Oportunidades',
  hechos: 'Hechos_Compartidos',
  aarc: 'Evaluaciones_AARC',
} as const;

export type ExtendedKey = keyof typeof EXTENDED_MODULES;
export type ExtendedRecords = { readonly [K in ExtendedKey]: readonly AnalysisRecord[] };

const EXTENDED_KEYS = Object.keys(EXTENDED_MODULES) as ExtendedKey[];

export const emptyExtended = (): ExtendedRecords => ({
  intereses: [],
  dialogos: [],
  oportunidades: [],
  hechos: [],
  aarc: [],
});

export const recordWithId = (record: StoredRecord): AnalysisRecord => ({
  ...record.payload,
  _id: record.id,
});

/** build_situational filter: `d.get("Proyecto_ID") or "PRJ-SECHURA"` (any falsy value defaults). */
export const situationalProject = (payload: Readonly<Record<string, unknown>>) =>
  pyTruthy(payload['Proyecto_ID']) ? payload['Proyecto_ID'] : DEFAULT_PROJECT_ID;

/** extended_records (app.py:709): only a missing Proyecto_ID defaults to PRJ-SECHURA. */
export const extendedRecords = (byModule: RecordsByModule, projectId: string): ExtendedRecords => {
  const result = emptyExtended() as Record<ExtendedKey, AnalysisRecord[]>;
  for (const key of EXTENDED_KEYS)
    result[key] = (byModule[EXTENDED_MODULES[key]] ?? [])
      .filter((r) => pyGet(r.payload, 'Proyecto_ID', DEFAULT_PROJECT_ID) === projectId)
      .map(recordWithId);
  return result;
};

export const extendedCounts = (records: ExtendedRecords) =>
  Object.fromEntries(EXTENDED_KEYS.map((key) => [key, records[key].length])) as Record<
    ExtendedKey,
    number
  >;
