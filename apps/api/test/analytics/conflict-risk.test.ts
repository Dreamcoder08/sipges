import { describe, expect, it } from 'vitest';
import {
  type RiskInput,
  type RiskRecord,
  assertNoLeakage,
  conflictRisk,
  featuresAt,
  indexSignals,
} from '../../src/contexts/analytics/domain/conflict-risk/index.ts';

// Synthetic data only: invented localities, actors and records.
const TODAY = '2026-11-02';

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

let seq = 0;
const rec = (module: string, payload: Record<string, unknown>, updatedAt?: string): RiskRecord => ({
  module,
  id: `${module.slice(0, 2)}-${++seq}`,
  payload,
  updatedAt: updatedAt ?? null,
});

const demand = (territory: string, day: string, extra: Record<string, unknown> = {}) =>
  rec('Demandas', { Territorio: territory, Fecha_Registro: day, Estado: 'Nueva', ...extra });
const narrative = (territory: string, day: string) =>
  rec('Narrativas', { Territorio: territory, Fecha_Inicio: day, Tono: 'Crítico' });
const redAlert = (territory: string, day: string) =>
  rec('Alertas', {
    Territorio: territory,
    Fecha: day,
    Nivel_Preliminar: 'Rojo',
    Estado: 'Abierta',
  });

const input = (records: RiskRecord[], extra: Partial<RiskInput> = {}): RiskInput => ({
  records,
  alerts: [],
  irsa: [],
  today: TODAY,
  ...extra,
});

describe('conflict-risk prediction', () => {
  it('answers «sin datos suficientes» and lists nothing when the project has no dated signals', () => {
    const report = conflictRisk(input([rec('Demandas', { Territorio: 'Pampa Alta' })]));
    expect(report.status).toBe('sin datos suficientes');
    expect(report.localities).toEqual([]);
    expect(report.actors).toEqual([]);
    expect(report.backtest['30'].calibrated).toBe(false);
  });

  it('ranks a locality with rising demands, critical narratives and alerts above a quiet one', () => {
    const quiet = [demand('Loma Verde', addDays(TODAY, -100))];
    const rising = [
      demand('Pampa Alta', addDays(TODAY, -60)),
      demand('Pampa Alta', addDays(TODAY, -20), { Prioridad: 'Alta' }),
      demand('Pampa Alta', addDays(TODAY, -5)),
      narrative('Pampa Alta', addDays(TODAY, -10)),
      narrative('Pampa Alta', addDays(TODAY, -3)),
      redAlert('Pampa Alta', addDays(TODAY, -2)),
    ];
    const before = conflictRisk(input([...quiet, ...rising.slice(0, 1)]));
    const after = conflictRisk(input([...quiet, ...rising]));
    const score = (r: typeof after, name: string) =>
      r.localities.find((l) => l.name === name)?.score ?? -1;
    expect(score(after, 'Pampa Alta')).toBeGreaterThan(score(before, 'Pampa Alta'));
    expect(after.localities[0]?.name).toBe('Pampa Alta');
    expect(after.localities[0]?.horizons['30'].band).toBe('alta');
    // Thin history: a band from signals, never a percentage pretending precision.
    expect(after.localities[0]?.horizons['30'].probability).toBeNull();
    expect(after.localities[0]?.confidence).toBe('baja');
    expect(after.backtest['90'].reason).toMatch(/Historial insuficiente/);
    const factors = after.localities[0]?.factors.map((f) => f.id) ?? [];
    expect(factors).toContain('alerts');
    const alertFactor = after.localities[0]?.factors.find((f) => f.id === 'alerts');
    expect(alertFactor?.records[0]).toMatchObject({ module: 'Alertas', date: addDays(TODAY, -2) });
  });

  it('ranks actors named in the records and splits actor lists', () => {
    const report = conflictRisk(
      input([
        rec('Demandas', {
          'Actor/Grupo': 'Comité de Riego Norte; Ronda Campesina Sur',
          Fecha_Registro: addDays(TODAY, -4),
          Estado: 'Nueva',
        }),
        rec('Narrativas', {
          Actor_Relacionado: 'comite de riego norte',
          Fecha_Inicio: addDays(TODAY, -2),
          Tono: 'Crítico',
        }),
      ]),
    );
    expect(report.actors.map((a) => a.name)).toEqual([
      'Comité de Riego Norte',
      'Ronda Campesina Sur',
    ]);
  });

  it('lifts every unit with a rising project IRSA and names it as a factor', () => {
    const records = [demand('Pampa Alta', addDays(TODAY, -10))];
    const flat = conflictRisk(input(records));
    const rising = conflictRisk(
      input(records, {
        irsa: [
          { ts: `${addDays(TODAY, -120)}T10:00:00Z`, irsa: 30 },
          { ts: `${addDays(TODAY, -1)}T10:00:00Z`, irsa: 70 },
        ],
      }),
    );
    expect(rising.localities[0]?.score).toBeGreaterThan(flat.localities[0]?.score ?? Infinity);
    expect(rising.localities[0]?.factors.map((f) => f.id)).toEqual(
      expect.arrayContaining(['irsa', 'irsa_rise']),
    );
  });

  it('counts a commitment fulfilled after the cut-off as still overdue at the cut-off', () => {
    const cutoff = addDays(TODAY, -60);
    const commitment = rec(
      'Compromisos',
      {
        Territorio: 'Pampa Alta',
        Fecha: addDays(TODAY, -120),
        Fecha_Vencimiento: addDays(TODAY, -90),
        Estado: 'Cumplido',
      },
      `${addDays(TODAY, -30)}T12:00:00Z`,
    );
    const index = indexSignals(input([commitment]));
    const atCutoff = featuresAt(index, 'L:pampa alta', cutoff, []);
    expect(atCutoff.find((f) => f.id === 'overdue_commitments')?.count).toBe(1);
    const now = featuresAt(index, 'L:pampa alta', TODAY, []);
    expect(now.find((f) => f.id === 'overdue_commitments')).toBeUndefined();
  });

  it('builds back-test features only from data dated on or before each cut-off', () => {
    const cutoff = addDays(TODAY, -90);
    const past = [demand('Pampa Alta', addDays(cutoff, -10)), narrative('Pampa Alta', cutoff)];
    const future = [
      demand('Pampa Alta', addDays(cutoff, 1)),
      redAlert('Pampa Alta', addDays(cutoff, 5)),
      narrative('Pampa Alta', addDays(cutoff, 20)),
    ];
    const irsa = [{ ts: `${addDays(cutoff, 3)}T00:00:00Z`, irsa: 90 }];
    const strip = (fs: ReturnType<typeof featuresAt>) =>
      fs.map(({ id, value, contribution }) => ({ id, value, contribution }));
    const without = featuresAt(indexSignals(input(past)), 'L:pampa alta', cutoff, []);
    const withFuture = featuresAt(
      indexSignals(input([...past, ...future], { irsa })),
      'L:pampa alta',
      cutoff,
      irsa,
    );
    expect(strip(withFuture)).toEqual(strip(without));
  });

  it('the leakage guard refuses a sample whose basis is dated after its cut-off', () => {
    const cutoff = '2026-06-01';
    expect(() =>
      assertNoLeakage(cutoff, [
        {
          id: 'demands',
          records: [{ module: 'Demandas', id: 'd1', title: 'x', date: '2026-06-02' }],
        },
      ]),
    ).toThrow(/leakage/i);
    expect(() =>
      assertNoLeakage(cutoff, [
        { id: 'demands', records: [{ module: 'Demandas', id: 'd1', title: 'x', date: cutoff }] },
      ]),
    ).not.toThrow();
  });

  it('calibrates on a long synthetic history and reports Brier, skill and the sample size', () => {
    // Two years, twelve localities: those with recurring demands escalate more often.
    const records: RiskRecord[] = [];
    for (let l = 0; l < 12; l += 1) {
      const name = `Localidad ${l}`;
      const hot = l < 4;
      for (let day = -730; day <= -1; day += hot ? 9 : 40)
        records.push(demand(name, addDays(TODAY, day)));
      for (let day = -700; day <= -1; day += hot ? 45 : 400)
        records.push(redAlert(name, addDays(TODAY, day)));
    }
    const report = conflictRisk(input(records));
    const bt = report.backtest['90'];
    expect(bt.calibrated).toBe(true);
    expect(bt.train.samples).toBeGreaterThanOrEqual(30);
    expect(bt.test.samples).toBeGreaterThanOrEqual(10);
    expect(bt.brier).not.toBeNull();
    expect(bt.brierReference).not.toBeNull();
    expect(bt.skill).toBeGreaterThan(0);
    expect(bt.bins.reduce((n, b) => n + b.n, 0)).toBe(bt.test.samples);
    const top = report.localities[0];
    expect(top?.name).toMatch(/Localidad [0-3]$/);
    const p90 = top?.horizons['90'].probability ?? null;
    expect(p90).not.toBeNull();
    expect(Math.round((p90 ?? 0) * 100) % 5).toBe(0);
    expect(['media', 'alta']).toContain(top?.confidence);
  });

  it('ignores alerts SIPGES generated itself', () => {
    const report = conflictRisk(
      input([
        rec('Alertas', {
          Territorio: 'Pampa Alta',
          Fecha: addDays(TODAY, -3),
          Nivel_Preliminar: 'Rojo',
          Origen: 'SIPGES',
        }),
      ]),
    );
    expect(report.status).toBe('sin datos suficientes');
  });
});
