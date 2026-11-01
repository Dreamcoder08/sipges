import type { ModuleRecord } from '@sipges/contracts';
import { fieldValue } from '../model.ts';
import { MODULES, type RecordModule } from '../modules.ts';

export const VERIFICATION_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type VerificationLetter = (typeof VERIFICATION_LETTERS)[number];
export const VALIDATION_STATES = ['Preliminar', 'En revisión', 'Validado'] as const;

/** «B - Corroborada» → B. Other wordings («Por verificar») have no A–E grade. */
export const verificationLetter = (label: string): VerificationLetter | undefined =>
  VERIFICATION_LETTERS.find((letter) => label.startsWith(`${letter} -`));

export type RecordSummary = {
  module: RecordModule;
  id: string;
  title: string;
  territory: string;
  date: string;
  verification: VerificationLetter | undefined;
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
