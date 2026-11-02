import type { ModuleName, Payload } from './modules.ts';

/**
 * Where each column of Registros «Todos» lives in a type's payload. Each entry lists the
 * canonical key first and then the imported aliases, mirroring the web field definitions
 * (apps/web/src/features/records/modules.ts) so the cross-type list reads what the type
 * screen shows. A type that does not define a field has no keys for that column.
 */
type Columns = {
  readonly title: readonly string[];
  readonly territory: readonly string[];
  readonly date: readonly string[];
  readonly verification: readonly string[];
  readonly validation: readonly string[];
};

const TERRITORY = ['Territorio'];
const VERIFICATION = ['Nivel_Verificacion'];

/** Hub record types, by slug, in the order of the Registros chips. */
export const SUMMARY_TYPES = [
  {
    slug: 'eventos',
    module: 'Eventos',
    columns: {
      title: ['Descripcion_Hecho'],
      territory: TERRITORY,
      date: ['Fecha'],
      verification: VERIFICATION,
      validation: ['Estado_Validacion'],
    },
  },
  {
    slug: 'actores',
    module: 'Actores',
    columns: {
      title: ['Nombre_Actor/Organizacion'],
      territory: TERRITORY,
      date: [],
      verification: [],
      validation: [],
    },
  },
  {
    slug: 'directorio',
    module: 'Directorio_Territorial',
    columns: {
      title: ['Nombre', 'Nombre actualizado 2026'],
      territory: ['Territorio', 'Lugar / ámbito', 'Ciudad', 'Distrito', 'Localidad'],
      date: [],
      verification: [],
      validation: [],
    },
  },
  {
    slug: 'demandas',
    module: 'Demandas',
    columns: {
      title: ['Descripcion'],
      territory: TERRITORY,
      date: ['Fecha_Registro'],
      verification: [],
      validation: [],
    },
  },
  {
    slug: 'narrativas',
    module: 'Narrativas',
    columns: {
      title: ['Descripcion'],
      territory: [],
      date: ['Fecha_Inicio'],
      verification: VERIFICATION,
      validation: [],
    },
  },
  {
    slug: 'fuentes',
    module: 'Fuentes',
    columns: {
      title: ['Archivo_Fuente'],
      territory: [],
      date: ['Fecha_Documento'],
      verification: ['Nivel_Base_Verificacion'],
      validation: [],
    },
  },
  {
    slug: 'buzon',
    module: 'Buzon',
    columns: {
      title: ['Asunto'],
      territory: TERRITORY,
      date: ['Fecha'],
      verification: [],
      validation: [],
    },
  },
] as const satisfies readonly {
  readonly slug: string;
  readonly module: ModuleName;
  readonly columns: Columns;
}[];

export type SummaryType = (typeof SUMMARY_TYPES)[number];
export type SummarySlug = SummaryType['slug'];

const LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type VerificationLetter = (typeof LETTERS)[number];

export type RecordSummary = {
  readonly slug: SummarySlug;
  readonly id: string;
  readonly title: string;
  readonly territory: string;
  readonly date: string;
  readonly verification: VerificationLetter | null;
  readonly validation: string;
};

const display = (value: unknown) =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** The canonical key wins when present (even cleared); otherwise the first filled alias. */
const read = (payload: Payload, [key, ...aliases]: readonly string[]) => {
  if (key === undefined) return '';
  if (Object.hasOwn(payload, key)) return display(payload[key]).trim();
  const alias = aliases.find((name) => payload[name] != null && payload[name] !== '');
  return alias === undefined ? '' : display(payload[alias]).trim();
};

/** «B - Corroborada» → B. Other wordings («Por verificar») have no A–E grade. */
const letterOf = (label: string) =>
  LETTERS.find((letter) => label.startsWith(`${letter} -`)) ?? null;

/** The columns of Registros «Todos» for one stored record. */
export const summarizeRecord = (
  type: SummaryType,
  id: string,
  payload: Payload,
): RecordSummary => ({
  slug: type.slug,
  id,
  title: read(payload, type.columns.title) || id,
  territory: read(payload, type.columns.territory),
  date: read(payload, type.columns.date),
  verification: letterOf(read(payload, type.columns.verification)),
  validation: read(payload, type.columns.validation),
});
