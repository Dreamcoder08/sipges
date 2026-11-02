import {
  type IrsaPoint,
  type Signal,
  type SignalIndex,
  type SourceRef,
  addDays,
  dayOf,
  daysBetween,
} from './signals.ts';

/** Factors of docs/adr/0031 §2, with their fixed weights and the words the screen shows. */
export const FACTORS = {
  open_demands: { weight: 0.6, label: 'Demandas abiertas (últimos 180 días)' },
  overdue_commitments: { weight: 0.8, label: 'Compromisos vencidos sin cumplir' },
  negative_narratives: { weight: 0.5, label: 'Narrativas críticas (últimos 90 días)' },
  narrative_rise: { weight: 0.4, label: 'Aumento de narrativas críticas (último mes)' },
  alerts: { weight: 0.9, label: 'Alertas (últimos 90 días, por nivel)' },
  escalations: { weight: 0.7, label: 'Escalamientos recientes (últimos 90 días)' },
  irsa: { weight: 0.8, label: 'IRSA del proyecto' },
  irsa_rise: { weight: 0.4, label: 'Subida del IRSA (últimos 90 días)' },
  recency: { weight: 0.5, label: 'Días desde la última señal' },
} as const;

export type FactorId = keyof typeof FACTORS;

export type Factor = {
  readonly id: FactorId;
  readonly label: string;
  /** What was counted (records, weighted sum or IRSA points), before the transform. */
  readonly count: number;
  /** The transformed value the weight multiplies. */
  readonly value: number;
  readonly contribution: number;
  /** Newest first, at most five; empty for project-level IRSA factors. */
  readonly records: readonly SourceRef[];
};

const MAX_REFS = 5;
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

const factor = (id: FactorId, count: number, value: number, basis: readonly Signal[]): Factor => ({
  id,
  label: FACTORS[id].label,
  count: round(count),
  value: round(value),
  contribution: round(FACTORS[id].weight * value),
  records: [...basis]
    .reverse()
    .slice(0, MAX_REFS)
    .map(({ module, id: recordId, title, date }) => ({ module, id: recordId, title, date })),
});

/** Window `(t − days, t]`; `since` is precomputed with `addDays(t, -days)`. */
const after = (s: Signal, since: string, t: string) => s.date > since && s.date <= t;
const openAt = (s: Signal, t: string) => s.closedOn === null || s.closedOn > t;
const sum = (signals: readonly Signal[]) => signals.reduce((n, s) => n + s.weight, 0);

/** Latest IRSA value on or before `day`, null when there is none. */
const irsaAt = (points: readonly IrsaPoint[], day: string) => {
  let best: { day: string; irsa: number } | null = null;
  for (const p of points) {
    const d = dayOf(p.ts);
    if (d && d <= day && (!best || d >= best.day)) best = { day: d, irsa: p.irsa };
  }
  return best;
};

/**
 * Factors of one unit as of day `t` (docs/adr/0031 §2). Only signals dated on or before `t`
 * are read, and a status counts as of `t`, so the same call serves the back-test without
 * leakage. Factors with no basis are left out.
 */
export const featuresAt = (
  index: SignalIndex,
  unit: string,
  t: string,
  irsa: readonly IrsaPoint[],
): Factor[] => {
  const past = (index.byUnit.get(unit) ?? []).filter((s) => s.date <= t);
  const d30 = addDays(t, -30);
  const d90 = addDays(t, -90);
  const d180 = addDays(t, -180);
  const of = (kind: Signal['kind']) => past.filter((s) => s.kind === kind);
  const factors: Factor[] = [];
  const push = (id: FactorId, count: number, value: number, basis: readonly Signal[]) => {
    if (value > 0) factors.push(factor(id, count, value, basis));
  };

  const demands = of('demand').filter((s) => after(s, d180, t) && openAt(s, t));
  push('open_demands', sum(demands), Math.log1p(sum(demands)), demands);

  const overdue = of('commitment').filter(
    (s) => s.dueDate !== null && s.dueDate < t && openAt(s, t),
  );
  push('overdue_commitments', overdue.length, Math.log1p(overdue.length), overdue);

  const negative = of('narrative').filter((s) => s.negative);
  const last90 = negative.filter((s) => after(s, d90, t));
  push('negative_narratives', last90.length, Math.log1p(last90.length), last90);
  const last30 = last90.filter((s) => after(s, d30, t));
  const rise = Math.min(3, Math.max(0, last30.length - (last90.length - last30.length) / 2));
  push('narrative_rise', rise, Math.log1p(rise), last30);

  const alerts = of('alert').filter((s) => after(s, d90, t) && openAt(s, t));
  push('alerts', sum(alerts), Math.log1p(sum(alerts)), alerts);

  const escalations = of('escalation').filter((s) => after(s, d90, t));
  push('escalations', escalations.length, Math.log1p(escalations.length), escalations);

  const level = irsaAt(irsa, t);
  if (level) {
    push('irsa', level.irsa, level.irsa / 100, []);
    const before = irsaAt(irsa, d90);
    const start =
      before ??
      irsa
        .map((p) => ({ day: dayOf(p.ts), irsa: p.irsa }))
        .filter((p) => p.day !== null && p.day > d90 && p.day <= t)
        .sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''))[0];
    if (start) {
      const delta = level.irsa - start.irsa;
      push('irsa_rise', delta, Math.min(1, Math.max(0, delta / 25)), []);
    }
  }

  const last = past.at(-1);
  if (last) {
    const days = daysBetween(last.date, t);
    push('recency', days, Math.exp(-days / 30), [last]);
  }
  return factors.sort((a, b) => b.contribution - a.contribution);
};

export const scoreOf = (factors: readonly Factor[]) =>
  round(
    factors.reduce((n, f) => n + f.contribution, 0),
    3,
  );

/** Signals of the unit in the 180 days up to `t`: a unit without any is not a sample. */
export const recentSignals = (index: SignalIndex, unit: string, t: string) => {
  const since = addDays(t, -180);
  return (index.byUnit.get(unit) ?? []).filter((s) => after(s, since, t)).length;
};

/** Whether the unit escalated in `(t, t + horizon]`; labels may use final statuses. */
export const escalatedWithin = (index: SignalIndex, unit: string, t: string, horizon: number) => {
  const until = addDays(t, horizon);
  return (index.byUnit.get(unit) ?? []).some(
    (s) => s.kind === 'escalation' && s.date > t && s.date <= until,
  );
};

/** Refuses a back-test sample whose basis holds a record dated after its cut-off. */
export const assertNoLeakage = (
  t: string,
  factors: readonly { readonly id: string; readonly records: readonly SourceRef[] }[],
) => {
  for (const f of factors)
    for (const r of f.records)
      if (r.date > t)
        throw new Error(
          `Back-test leakage: ${f.id} uses ${r.module} ${r.id} dated ${r.date} after ${t}`,
        );
};
