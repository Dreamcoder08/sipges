import { pyGet, pyStr, pyStrip, pyTruthy } from './python.ts';
import type { AnalysisRecord, ExtendedKey, ExtendedRecords } from './records.ts';

// app.py STOPWORDS (RC 1.9), verbatim.
const STOPWORDS = new Set(
  'para como entre desde sobre este esta estos estas donde cuando porque alguno alguna unas unos los las del por con que una uno algo ante bajo frente proyecto actor actores local locales comunidad comunidades territorio registro propuesta proceso potencial posible sus suyo caso debe estar parte mediante'.split(
    ' ',
  ),
);

/** app.py thematic_terms: accent-insensitive 4+ letter tokens without stopwords. */
export const thematicTerms = (value: unknown): Set<string> => {
  const text = pyStr(pyTruthy(value) ? value : '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
  return new Set((text.match(/[a-z]{4,}/g) ?? []).filter((t) => !STOPWORDS.has(t)));
};

const ID_FIELDS = ['ID_Actor', 'ID_Demanda', 'ID_Proceso', 'Tema_ID', 'Vinculo_ID'];
const REFERENCE_FIELDS = ['Registros_Relacionados', 'Referencias_ID'];

const references = (x: AnalysisRecord, field: string) =>
  new Set(
    pyStr(pyGet(x, field))
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  );

/** What record_links compares, computed once per record instead of once per pair. */
type LinkKeys = {
  readonly id: string;
  /** Stripped, lower-cased ID_FIELDS values ('' when empty), in field order. */
  readonly ids: readonly string[];
  /** Comma-separated REFERENCE_FIELDS values as sets, in field order. */
  readonly refs: readonly ReadonlySet<string>[];
};

const linkKeys = (x: AnalysisRecord): LinkKeys => ({
  id: x._id,
  ids: ID_FIELDS.map((field) => pyStrip(pyGet(x, field)).toLowerCase()),
  refs: REFERENCE_FIELDS.map((field) => references(x, field)),
});

const linkBetween = (a: LinkKeys, b: LinkKeys): readonly [string, string[]] | null => {
  for (let i = 0; i < ID_FIELDS.length; i += 1) {
    const left = a.ids[i];
    if (left && left === b.ids[i]) return ['referencia explícita', [ID_FIELDS[i] ?? '']];
  }
  for (let i = 0; i < REFERENCE_FIELDS.length; i += 1) {
    const left = a.refs[i] ?? new Set<string>();
    const right = b.refs[i] ?? new Set<string>();
    if (right.has(a.id) || left.has(b.id) || [...left].some((t) => right.has(t)))
      return ['referencia cruzada', []];
  }
  return null;
};

/** app.py record_links: explicit shared ID, or a cross reference between the two records. */
export const recordLinks = (
  a: AnalysisRecord,
  b: AnalysisRecord,
): readonly [string, string[]] | null => linkBetween(linkKeys(a), linkKeys(b));

type PairSpec = readonly [ExtendedKey, ExtendedKey, readonly string[], readonly string[]];

const SPECS: readonly PairSpec[] = [
  [
    'intereses',
    'oportunidades',
    ['Interes', 'Preocupacion'],
    ['Oportunidad', 'Tipo', 'Beneficiarios'],
  ],
  ['hechos', 'dialogos', ['Asunto', 'Preguntas'], ['Tema', 'Proceso']],
  ['intereses', 'dialogos', ['Posicion', 'Interes', 'Preocupacion'], ['Tema', 'Proceso']],
  ['hechos', 'oportunidades', ['Asunto', 'Preguntas'], ['Oportunidad', 'Restricciones']],
];

const PER_MODULE = 150;
const MAX_PAIRS = 120;

const joined = (x: AnalysisRecord, fields: readonly string[]) =>
  fields.map((k) => pyStr(pyTruthy(pyGet(x, k)) ? pyGet(x, k) : '')).join(' ');

export type CandidateLink = {
  readonly origen: string;
  readonly destino: string;
  readonly criterio: string;
  readonly terminos_compartidos: readonly string[];
  readonly estado: string;
  readonly uso_sugerido: string;
};

/**
 * app.py candidate_pairs (RC 1.9): reproducible cross-module hypotheses. A link never implies
 * consent, representation or approval.
 */
export const candidatePairs = (r: ExtendedRecords): CandidateLink[] => {
  const out: CandidateLink[] = [];
  for (const [modA, modB, fieldsA, fieldsB] of SPECS) {
    // Terms and link keys are computed once per record (ADR 0005, T12); app.py recomputed
    // them for every pair. Pair order and results are unchanged.
    const right = r[modB].slice(0, PER_MODULE).map((y) => ({
      y,
      keys: linkKeys(y),
      terms: thematicTerms(joined(y, fieldsB)),
    }));
    for (const x of r[modA].slice(0, PER_MODULE)) {
      const keys = linkKeys(x);
      const left = [...thematicTerms(joined(x, fieldsA))];
      for (const other of right) {
        const link = linkBetween(keys, other.keys);
        const shared = left.filter((t) => other.terms.has(t)).sort();
        if (!link && shared.length < 2) continue;
        out.push({
          origen: `${modA}/${x._id}`,
          destino: `${modB}/${other.y._id}`,
          criterio: link ? link[0] : 'coincidencia léxica (no implica relación probada)',
          terminos_compartidos: shared.slice(0, 8),
          estado: 'Hipótesis de vínculo; verificar con fuentes y participantes',
          uso_sugerido:
            'Revisar pertinencia del vínculo, intereses expresados y posibles restricciones antes de diseñar opciones',
        });
        // Only the first MAX_PAIRS are returned, so later pairs cannot change the result.
        if (out.length === MAX_PAIRS) return out;
      }
    }
  }
  return out;
};
