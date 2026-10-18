import { foldText } from '../../shared/lib/text.ts';

/**
 * Information state of a territorial record (ODD geospatial-timeline S4). A social event does
 * not spread like a fire: nothing here predicts or extrapolates. Each state says how much the
 * record itself supports what is drawn.
 */
export const EVIDENCE = ['observado', 'estimado', 'escenario'] as const;
export type Evidence = (typeof EVIDENCE)[number];

export const EVIDENCE_LABELS: Readonly<Record<Evidence, string>> = {
  observado: 'Observado',
  estimado: 'Estimado',
  escenario: 'Escenario hipotético',
};

export const EVIDENCE_HINTS: Readonly<Record<Evidence, string>> = {
  observado: 'Hecho con verificación A, B o C y referencia de fuente.',
  estimado: 'Registro sin verificación suficiente o sin fuente; requiere revisión.',
  escenario: 'Declarado como escenario por quien lo registró; no ocurrió.',
};

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** `Estado_Informacion` as written by a person, when it names one of the three states. */
const declared = (value: unknown): Evidence | null => {
  const folded = foldText(value);
  if (!folded) return null;
  if (folded.startsWith('escenario')) return 'escenario';
  if (folded.startsWith('observado')) return 'observado';
  if (folded.startsWith('estimado')) return 'estimado';
  return null;
};

/** Verification grades the methodology accepts as observed (A Confirmada … C Parcial). */
const OBSERVED_GRADES = new Set(['a', 'b', 'c']);

/**
 * The state and the reason it was assigned. A declared state wins, except that "Observado"
 * still needs a verification grade and a source: a person's word alone does not make a fact.
 * Undeclared records are observed only with grade A–C and a source; otherwise estimated.
 * Scenarios are never inferred.
 */
export const evidenceOf = (
  record: Readonly<Record<string, unknown>>,
): { state: Evidence; basis: string } => {
  const grade = foldText(record['Nivel_Verificacion']).slice(0, 1);
  const source = text(record['Fuente_ID']);
  const verified = OBSERVED_GRADES.has(grade) && Boolean(source);
  const stated = declared(record['Estado_Informacion']);
  if (stated === 'escenario')
    return { state: 'escenario', basis: 'Declarado como escenario hipotético en el registro' };
  if (stated === 'estimado')
    return { state: 'estimado', basis: 'Declarado como estimado en el registro' };
  if (verified)
    return {
      state: 'observado',
      basis: `Verificación ${text(record['Nivel_Verificacion'])} con fuente ${source}`,
    };
  const missing = [
    OBSERVED_GRADES.has(grade) ? '' : 'verificación A–C',
    source ? '' : 'referencia de fuente',
  ].filter(Boolean);
  return {
    state: 'estimado',
    basis: `${stated === 'observado' ? 'Declarado observado, pero falta' : 'Falta'} ${missing.join(' y ')}`,
  };
};
