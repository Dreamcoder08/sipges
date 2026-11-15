import { keyWords } from '../../shared/lib/text.ts';

/**
 * Names of the IRSA values the API stores under keys (functional-10 T3, F7 and F11). The keys
 * themselves are what the configuration saves; only the screen reads these.
 */
const CONTRIBUTIONS: Readonly<Record<string, string>> = {
  active_alert: 'alerta activa',
  high_event: 'evento de nivel alto',
  critical_event: 'evento crítico',
  open_demand: 'demanda abierta',
  pending_action: 'acción pendiente',
  unverified_narrative: 'narrativa no verificada',
};

/** «Contribución de alerta activa» for `active_alert`; an unknown key reads as words. */
export const contributionLabel = (key: string) =>
  `Contribución de ${CONTRIBUTIONS[key] ?? keyWords(key).toLocaleLowerCase('es')}`;

/**
 * The IRSA method a cut was computed with, apart from the SIPGES version (functional-10 T8):
 * `0.4-indicators` reads «Método IRSA v0.4». A cut saved without one says so.
 */
export const irsaMethodLabel = (version: string | null | undefined) => {
  const text = version?.trim() ?? '';
  if (!text) return 'Sin versión del método';
  const number = /^v?(\d+(?:\.\d+)*)/i.exec(text)?.[1];
  return number ? `Método IRSA v${number}` : `Método IRSA ${keyWords(text)}`;
};

/**
 * Field names that reach the screen inside the indicator engine's method text, as the record
 * forms name them. The engine's strings live in engines/ and stay byte-identical across the
 * TypeScript, Rust and Go builds, so the screen words them.
 */
const STORED_TERMS: readonly (readonly [RegExp, string])[] = [
  [/\bFuente_ID\b/g, 'referencia de fuente'],
];

/** «… registros clave con referencia de fuente …» instead of «… con Fuente_ID …». */
export const plainMethod = (text: string) =>
  STORED_TERMS.reduce((result, [term, words]) => result.replace(term, words), text);
