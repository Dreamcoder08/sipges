import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IRSA_CONFIG } from '../src/contexts/indicators/domain/defaults.ts';
import { DIMENSIONS, type IndicatorsReport } from '../src/contexts/indicators/domain/indicators.ts';
import { computeIrsa } from '../src/contexts/indicators/domain/irsa.ts';
import { analyzeText } from '../src/contexts/intelligence/domain/text-analysis.ts';

/**
 * Runs the scenario tables the social team keeps in docs/escenarios/ (docs/adr/0024 §3): each
 * Markdown table row is one expected outcome of a domain rule.
 */
const table = (file: string) => {
  const rows = readFileSync(new URL(`../../../docs/escenarios/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, line.trimEnd().endsWith('|') ? line.trimEnd().length - 1 : undefined)
        .split('|')
        .map((cell) => cell.trim()),
    );
  const [header = [], ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('docs/escenarios/alertas.md', () => {
  const rows = table('alertas.md');
  it('has scenarios', () => expect(rows.length).toBeGreaterThan(0));
  it.each(rows)('$Prioridad: $Texto', (row) => {
    const result = analyzeText(
      { text: row.Texto ?? '', projectId: 'PRJ-ESCENARIO', sourceUrl: '' },
      [],
      sha256,
    );
    if (!result.ok) throw new Error(`Texto no analizable: ${result.error.kind}`);
    expect(result.value.orientation.level).toBe(row.Prioridad);
    const expected = (row['Señales'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect(result.value.signals.map((s) => s.senal).sort()).toEqual(expected);
  });
});

describe('docs/escenarios/irsa.md', () => {
  const rows = table('irsa.md');
  it('has scenarios', () => expect(rows.length).toBeGreaterThan(0));
  it.each(rows)('$Semáforo: $Caso', (row) => {
    const scores = Object.fromEntries(DIMENSIONS.map((d) => [d, Number(row[d])]));
    const report = {
      dimension_scores: scores,
      dimensions: Object.fromEntries(DIMENSIONS.map((d) => [d, []])),
      availability: Object.fromEntries(DIMENSIONS.map((d) => [d, 1])),
      indicators: [],
      method_note: '',
      validation_status: '',
    } as unknown as IndicatorsReport;
    expect(computeIrsa(DEFAULT_IRSA_CONFIG, report).level).toBe(row['Semáforo']);
  });
});
