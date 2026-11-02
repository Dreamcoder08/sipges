/** A module record as persisted: its id and JSON payload. */
export type StoredRecord = {
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

/** Records of each module, newest first (app.py `ORDER BY updated_at DESC`). */
export type RecordsByModule = Readonly<Record<string, readonly StoredRecord[]>>;

/** A payload with its record id under `_id`, as app.py engines see it. */
export type AnalysisRecord = Readonly<Record<string, unknown>> & { readonly _id: string };

/** Legacy project of the Python installation, named «Proyecto Sechura» in its reports. */
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

/**
 * extended_records (app.py:709). The tenant is the project (S13): every record it holds counts,
 * whatever its `Proyecto_ID` field says, so all screens count the same records.
 */
export const extendedRecords = (byModule: RecordsByModule): ExtendedRecords => {
  const result = emptyExtended() as Record<ExtendedKey, AnalysisRecord[]>;
  for (const key of EXTENDED_KEYS)
    result[key] = (byModule[EXTENDED_MODULES[key]] ?? []).map(recordWithId);
  return result;
};

export const extendedCounts = (records: ExtendedRecords) =>
  Object.fromEntries(EXTENDED_KEYS.map((key) => [key, records[key].length])) as Record<
    ExtendedKey,
    number
  >;
