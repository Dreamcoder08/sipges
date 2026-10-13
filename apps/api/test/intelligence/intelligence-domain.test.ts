import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  analyzeText,
  classifyRecord,
  cosine,
  isPublicHttpUrl,
} from '../../src/contexts/intelligence/domain/index.ts';
import { pyJsonDumps, pyRound } from '../../src/contexts/intelligence/domain/python.ts';
import {
  type ActionRow,
  managementCsv,
  managementOverview,
} from '../../src/contexts/management/domain/index.ts';
import parity from './python-parity.fixture.json' with { type: 'json' };

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('Python parity (scripts/python-parity/operations.py)', () => {
  it.each(parity.classifier.map((c, i) => [i, c] as const))(
    'classifies synthetic record %i like app.py',
    (_, { payload, expected }) => {
      expect(classifyRecord(payload)).toEqual(expected);
    },
  );

  it.each(parity.text_analysis.map((c, i) => [i, c] as const))(
    'analyzes synthetic text %i like app.py',
    (_, { text, expected }) => {
      const result = analyzeText(
        { text, projectId: 'PRJ-SECHURA', sourceUrl: 'https://example.org/p' },
        parity.narratives,
        sha256,
      );
      expect(result).toEqual({ ok: true, value: expected });
    },
  );

  it('writes the management CSV byte for byte like csv.writer', () => {
    const r = parity.csv_report;
    const overview = managementOverview({
      projectId: r.project_id,
      generatedAt: r.generated_at,
      today: '2026-10-12',
      alerts: [],
      actions: [],
      commitments: [],
    });
    const csv = managementCsv({
      ...overview,
      metrics: r.metrics as typeof overview.metrics,
      critical_actions: r.critical_actions.map((a) => ({
        ...a,
        id: '',
        alert_id: '',
        updated_at: '',
      })),
    });
    expect(csv).toBe(parity.csv);
  });
});

describe('Python helpers', () => {
  it('rounds exact halves to even like round()', () => {
    expect([pyRound(0.5), pyRound(1.5), pyRound(2.5), pyRound(84.75 - 0.25)]).toEqual([
      0, 2, 2, 84,
    ]);
    expect(pyRound(12.25, 1)).toBe(12.2);
  });

  it('serializes like json.dumps(ensure_ascii=False)', () => {
    expect(pyJsonDumps({ a: [1, 'ñ"\n'], b: null, c: true })).toBe(
      '{"a": [1, "ñ\\"\\n"], "b": null, "c": true}',
    );
  });

  it('accepts only http(s) URLs with a host', () => {
    expect(isPublicHttpUrl('https://example.org/x')).toBe(true);
    expect(isPublicHttpUrl('HTTP://example.org')).toBe(true);
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isPublicHttpUrl('https:///nohost')).toBe(false);
  });

  it('computes cosine similarity and treats mismatched vectors as unrelated', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('text analysis limits', () => {
  it('refuses empty and overlong text', () => {
    const run = (text: string) => analyzeText({ text, projectId: 'P', sourceUrl: '' }, [], sha256);
    expect(run('   ')).toEqual({ ok: false, error: { kind: 'empty' } });
    expect(run('😀'.repeat(20_001))).toEqual({ ok: false, error: { kind: 'too_long' } });
    expect(run('😀'.repeat(20_000)).ok).toBe(true);
  });
});

describe('management overview', () => {
  const action = (over: Partial<ActionRow>): ActionRow => ({
    id: 'PREV-1',
    alertId: 'DIG-1',
    title: 'Plan',
    responsible: 'Equipo',
    dueDate: '2026-10-20',
    status: 'Pendiente',
    progress: 0,
    updatedAt: '2026-10-12T12:00:00Z',
    ...over,
  });

  it('counts overdue work and neutralizes spreadsheet formulas in the CSV', () => {
    const overview = managementOverview({
      projectId: 'P',
      generatedAt: '2026-10-12T12:00:00Z',
      today: '2026-10-12',
      alerts: [],
      actions: [
        action({ id: 'A', dueDate: '2026-10-01', title: '=HYPERLINK("x")' }),
        action({ id: 'B', status: 'Completada', progress: 100, dueDate: '2026-09-01' }),
      ],
      commitments: [
        { id: 'C1', responsible: '', status: 'Vencido', due_date: '' },
        { id: 'C2', responsible: '', status: 'Abierto', due_date: '' },
      ],
    });
    expect(overview.metrics).toMatchObject({
      total_actions: 2,
      active_actions: 1,
      overdue_actions: 1,
      completion_percent: 50,
      average_progress: 50,
      overdue_commitments_explicit: 1,
    });
    expect(overview.critical_actions.map((a) => a.id)).toEqual(['A']);
    const csv = managementCsv(overview);
    expect(csv).toContain(`"'=HYPERLINK(""x"")",Equipo,2026-10-01,Pendiente,0\r\n`);
    expect(csv).toContain('completion_percent,50.0\r\n');
  });
});
