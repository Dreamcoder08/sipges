import type { ModuleRecord } from '@sipges/contracts';
import { fieldValue } from '../model.ts';
import { MODULES, type RecordModule } from '../modules.ts';

export const VERIFICATION_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type VerificationLetter = (typeof VERIFICATION_LETTERS)[number];
/** The word each grade carries in the field options (modules.ts): «B - Corroborada». */
export const VERIFICATION_WORDS: Readonly<Record<VerificationLetter, string>> = {
  A: 'Confirmada',
  B: 'Corroborada',
  C: 'Parcial',
  D: 'Referencial',
  E: 'No verificada',
};
export const VALIDATION_STATES = ['Preliminar', 'En revisión', 'Validado'] as const;

/** «B - Corroborada» → B. Other wordings («Por verificar») have no A–E grade. */
export const verificationLetter = (label: string): VerificationLetter | null =>
  VERIFICATION_LETTERS.find((letter) => label.startsWith(`${letter} -`)) ?? null;

/**
 * The columns every record type shares. Registros «Todos» receives them from
 * GET /api/registros/summary (the server mirrors these field reads in
 * apps/api/src/contexts/records/domain/summary.ts); the record sheet derives them here.
 */
export type RecordSummary = {
  module: RecordModule;
  id: string;
  title: string;
  territory: string;
  date: string;
  verification: VerificationLetter | null;
  validation: string;
};

const VERIFICATION_KEYS = ['Nivel_Verificacion', 'Nivel_Base_Verificacion'];

/** The columns every record type shares, read through that type's own field definitions. */
export const summarize = (module: RecordModule, row: ModuleRecord): RecordSummary => {
  const { fields, titleField } = MODULES[module];
  const read = (key: string) => {
    const field = fields.find((item) => item.key === key);
    return field ? fieldValue(row, field).trim() : '';
  };
  const dateField = fields.find((item) => item.type === 'date');
  const verification = VERIFICATION_KEYS.map(read).find(Boolean) ?? '';
  return {
    module,
    id: row._id,
    title: read(titleField) || row._id,
    territory: read('Territorio'),
    date: dateField ? read(dateField.key) : '',
    verification: verificationLetter(verification),
    validation: read('Estado_Validacion'),
  };
};
