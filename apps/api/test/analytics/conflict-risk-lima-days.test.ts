import { describe, expect, it } from 'vitest';
import {
  type RiskAlert,
  type RiskInput,
  type RiskRecord,
  indexSignals,
} from '../../src/contexts/analytics/domain/conflict-risk/index.ts';

// Synthetic data only. Stored instants become calendar days in Lima (UTC−5, no DST); a civil date
// typed by a person, or a value without a zone, keeps its written day.
const TODAY = '2027-06-30';
const UNIT = 'L:pampa alta';

/** Each instant the rules name, with its Lima day. */
const INSTANTS: readonly (readonly [string, string])[] = [
  ['2026-11-02T02:00:00Z', '2026-11-01'],
  ['2026-11-02T04:59:59Z', '2026-11-01'],
  ['2026-11-02T05:00:00Z', '2026-11-02'],
  ['2026-11-02T05:00:00.000Z', '2026-11-02'],
  ['2026-10-31T23:59:59-05:00', '2026-10-31'],
  ['2026-11-01T01:00:00+02:00', '2026-10-31'],
  ['2026-12-01T04:59:59.999Z', '2026-11-30'],
  ['2027-01-01T03:00:00Z', '2026-12-31'],
  ['2027-01-01T05:00:00Z', '2027-01-01'],
  ['2024-03-01T02:00:00Z', '2024-02-29'],
];

/** Values that are not a zoned instant keep today's reading: written day, or null when invalid. */
const NOT_INSTANTS: readonly (readonly [string, string | null])[] = [
  ['2026-11-02', '2026-11-02'],
  ['2026-11-02T02:00:00', '2026-11-02'],
  ['2026-11-02T25:00:00Z', '2026-11-02'],
  ['2026-11-02T02:00:00+25:00', '2026-11-02'],
  ['2/11/2026', '2026-11-02'],
  ['2026-02-30T10:00:00Z', null],
  ['sin fecha', null],
];

const input = (records: RiskRecord[], alerts: RiskAlert[] = []): RiskInput => ({
  records,
  alerts,
  irsa: [],
  today: TODAY,
});

const signals = (data: RiskInput) => indexSignals(data).byUnit.get(UNIT) ?? [];

const closedDemand = (updatedAt: string | null): RiskRecord => ({
  module: 'Demandas',
  id: 'DE-1',
  payload: { Territorio: 'Pampa Alta', Fecha_Registro: '2026-10-01', Estado: 'Atendido' },
  updatedAt,
});

const alert = (createdAt: string, extra: Partial<RiskAlert> = {}): RiskAlert => ({
  id: 'AT-1',
  createdAt,
  territory: 'Pampa Alta',
  level: 'Media',
  status: 'Pendiente de verificación',
  reviewedAt: null,
  ...extra,
});

const discarded = (reviewedAt: string | null) =>
  alert('2026-10-01T15:00:00Z', { status: 'Descartado', reviewedAt });

describe('conflict-risk days of stored instants (Lima)', () => {
  it('R1: a closed record closes on the Lima day of its last update', () => {
    for (const [updatedAt, day] of INSTANTS)
      expect([updatedAt, signals(input([closedDemand(updatedAt)]))[0]?.closedOn]).toEqual([
        updatedAt,
        day,
      ]);
  });

  it('R2: a territorial alert is dated on the Lima day it was created', () => {
    for (const [createdAt, day] of INSTANTS)
      expect([createdAt, signals(input([], [alert(createdAt)]))[0]?.date]).toEqual([
        createdAt,
        day,
      ]);
  });

  it('R3: a discarded territorial alert closes on the Lima day it was reviewed', () => {
    for (const [reviewedAt, day] of INSTANTS)
      expect([reviewedAt, signals(input([], [discarded(reviewedAt)]))[0]?.closedOn]).toEqual([
        reviewedAt,
        day,
      ]);
  });

  it('keeps the written day of a value that is not a zoned instant, and its fallbacks', () => {
    for (const [value, day] of NOT_INSTANTS) {
      expect([value, signals(input([closedDemand(value)]))[0]?.closedOn]).toEqual([
        value,
        day ?? '2026-10-01',
      ]);
      expect([value, signals(input([], [alert(value)]))[0]?.date ?? null]).toEqual([value, day]);
      expect([value, signals(input([], [discarded(value)]))[0]?.closedOn]).toEqual([
        value,
        day ?? '2026-10-01',
      ]);
    }
    expect(signals(input([closedDemand(null)]))[0]?.closedOn).toBe('2026-10-01');
    expect(signals(input([], [discarded(null)]))[0]?.closedOn).toBe('2026-10-01');
  });

  it('reads payload dates typed by people as written, without a zone shift', () => {
    const dated = (Fecha_Registro: string): RiskRecord => ({
      module: 'Demandas',
      id: 'DE-2',
      payload: { Territorio: 'Pampa Alta', Fecha_Registro, Estado: 'Nueva' },
      updatedAt: null,
    });
    expect(signals(input([dated('2026-11-02T02:00:00Z')]))[0]?.date).toBe('2026-11-02');
    expect(signals(input([dated('2/11/2026')]))[0]?.date).toBe('2026-11-02');
    expect(signals(input([dated('2026-11-02')]))[0]?.date).toBe('2026-11-02');
  });
});
