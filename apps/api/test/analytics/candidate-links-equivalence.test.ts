import { describe, expect, it } from 'vitest';
import { syntheticRecords } from '../../bench/synthetic.ts';
import {
  candidatePairs,
  recordLinks,
  thematicTerms,
} from '../../src/contexts/analytics/domain/candidate-links.ts';
import {
  type ExtendedRecords,
  extendedRecords,
} from '../../src/contexts/analytics/domain/records.ts';
import { pyGet, pyStr, pyTruthy } from '../../src/contexts/analytics/domain/python.ts';

/** app.py candidate_pairs as written: every pair recomputes terms and links. */
const SPECS = [
  [
    'intereses',
    'oportunidades',
    ['Interes', 'Preocupacion'],
    ['Oportunidad', 'Tipo', 'Beneficiarios'],
  ],
  ['hechos', 'dialogos', ['Asunto', 'Preguntas'], ['Tema', 'Proceso']],
  ['intereses', 'dialogos', ['Posicion', 'Interes', 'Preocupacion'], ['Tema', 'Proceso']],
  ['hechos', 'oportunidades', ['Asunto', 'Preguntas'], ['Oportunidad', 'Restricciones']],
] as const;

const naive = (r: ExtendedRecords) => {
  const joined = (x: Record<string, unknown>, fields: readonly string[]) =>
    fields.map((k) => pyStr(pyTruthy(pyGet(x, k)) ? pyGet(x, k) : '')).join(' ');
  const out: { origen: string; destino: string; criterio: string; terminos: string[] }[] = [];
  for (const [a, b, fa, fb] of SPECS) {
    for (const x of r[a].slice(0, 150)) {
      for (const y of r[b].slice(0, 150)) {
        const link = recordLinks(x, y);
        const left = thematicTerms(joined(x, fa));
        const right = thematicTerms(joined(y, fb));
        const shared = [...left].filter((t) => right.has(t)).sort();
        if (!link && shared.length < 2) continue;
        out.push({
          origen: `${a}/${x._id}`,
          destino: `${b}/${y._id}`,
          criterio: link ? link[0] : 'coincidencia léxica (no implica relación probada)',
          terminos: shared.slice(0, 8),
        });
      }
    }
  }
  return out.slice(0, 120);
};

const extended = (scale: number, seed: number) => {
  const records = syntheticRecords(scale, seed);
  const stored = Object.fromEntries(
    Object.entries(records).map(([m, rows]) => [
      m,
      rows.map((payload, i) => ({ id: `${m}-${i}`, payload })),
    ]),
  );
  return extendedRecords(stored, 'PRJ-SECHURA');
};

describe('candidatePairs optimisation (T12)', () => {
  it.each([
    [1, 1],
    [1, 5],
    [3, 2],
    [10, 3],
  ])('matches the per-pair algorithm at %i× volume (seed %i)', (scale, seed) => {
    const r = extended(scale, seed);
    const fast = candidatePairs(r).map((p) => ({
      origen: p.origen,
      destino: p.destino,
      criterio: p.criterio,
      terminos: [...p.terminos_compartidos],
    }));
    expect(fast).toEqual(naive(r));
  });

  it('matches it with explicit IDs, cross references and fewer pairs than the cap', () => {
    const base = extended(1, 9);
    const sparse = (rows: ExtendedRecords[keyof ExtendedRecords], module: string) =>
      rows.map((x, i) => ({
        ...x,
        // Only a few records keep text, so the lexical pairs stay under the cap.
        Interes: i % 7 === 0 ? x['Interes'] : '',
        Preocupacion: '',
        Posicion: '',
        Asunto: i % 9 === 0 ? x['Asunto'] : '',
        Preguntas: '',
        Oportunidad: i % 8 === 0 ? x['Oportunidad'] : '',
        Tipo: '',
        Beneficiarios: '',
        Restricciones: '',
        Tema: i % 6 === 0 ? x['Tema'] : '',
        Proceso: '',
        Tema_ID: i % 5 === 0 ? ` tem-${i % 3} ` : '',
        Registros_Relacionados:
          module === 'hechos' && i % 4 === 0 ? `Oportunidades-${i}, Dialogos-${i + 1}` : '',
        Referencias_ID: module !== 'hechos' && i % 4 === 0 ? `Hechos_Compartidos-${i}` : '',
      }));
    const r = Object.fromEntries(
      Object.entries(base).map(([module, rows]) => [module, sparse(rows, module)]),
    ) as unknown as ExtendedRecords;
    const fast = candidatePairs(r).map((p) => ({
      origen: p.origen,
      destino: p.destino,
      criterio: p.criterio,
      terminos: [...p.terminos_compartidos],
    }));
    const expected = naive(r);
    expect(expected.length).toBeLessThan(120);
    expect(new Set(expected.map((p) => p.criterio)).size).toBe(3);
    expect(fast).toEqual(expected);
  });
});
