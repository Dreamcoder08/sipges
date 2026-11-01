import type { ModuleRecord } from '@sipges/contracts';
import { foldText, type Level } from '../../../shared/lib/text.ts';
import { alertTerritory, LEVEL_ORDER, MISSING_TERRITORY, recordedLevel } from './alert-heatmap.ts';

/** Risk names of the methodology for the four recorded colours. */
export const LEVEL_LABEL: Readonly<Record<Level, string>> = {
  Verde: 'Bajo',
  Amarillo: 'Atención',
  Naranja: 'Medio-alto',
  Rojo: 'Crítico',
};

export type OverviewPeriod = 6 | 12 | 'todo';

const CLOSED = ['cerrada', 'cerrado', 'descartada', 'descartado'];
export const isActiveAlert = (row: ModuleRecord) =>
  !CLOSED.includes(foldText(String(row.Estado ?? '').trim()));

/** The alert's date as YYYY-MM-DD (ISO or dd/mm/yyyy), or null when it has none. */
export const alertDay = (row: ModuleRecord): string | null => {
  const value = String(row.Fecha ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  if (local) return `${local[3]}-${local[2]?.padStart(2, '0')}-${local[1]?.padStart(2, '0')}`;
  return null;
};

const addMonths = (month: string, n: number) => {
  const [year = 0, index = 1] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, index - 1 + n, 1));
  return date.toISOString().slice(0, 7);
};
const monthsBetween = (from: string, to: string) => {
  const months: string[] = [];
  for (let month = from; month <= to && months.length < 120; month = addMonths(month, 1))
    months.push(month);
  return months;
};

const levelRank = (level: Level | null) => (level ? LEVEL_ORDER.indexOf(level) : -1);

/**
 * Figures of the alert centre's overview, all computed from the stored alerts: no level,
 * territory or month is invented. The period ends in the current month (or the latest dated
 * alert, if later); undated alerts only count when the whole history is shown.
 */
export const alertOverview = (
  rows: readonly ModuleRecord[],
  events: readonly ModuleRecord[],
  period: OverviewPeriod,
  today: string,
) => {
  const dated = rows.map((row) => ({ row, day: alertDay(row) }));
  const lastDay = dated.reduce((max, { day }) => (day && day > max ? day : max), today);
  const end = lastDay.slice(0, 7);
  const firstDated = dated.reduce<string | null>(
    (min, { day }) => (day && (!min || day < min) ? day : min),
    null,
  );
  const start =
    period === 'todo'
      ? (firstDated ?? today).slice(0, 7) < addMonths(end, -11)
        ? (firstDated ?? today).slice(0, 7)
        : addMonths(end, -11)
      : addMonths(end, 1 - period);
  const months = monthsBetween(start, end);
  const inPeriod = dated
    .filter(({ day }) => (period === 'todo' ? true : day !== null && day.slice(0, 7) >= start))
    .map(({ row }) => row);
  const previous =
    period === 'todo'
      ? null
      : dated.filter(({ day }) => {
          const month = day?.slice(0, 7);
          return month !== undefined && month >= addMonths(start, -period) && month < start;
        }).length;

  const active = inPeriod.filter(isActiveAlert);
  const located = active.map((row) => ({
    row,
    territory: alertTerritory(row, events),
    level: recordedLevel(row),
  }));

  // Communities ranked by their highest recorded level, then by how many active alerts they have.
  const byTerritory = new Map<string, { level: Level | null; count: number }>();
  for (const { territory, level } of located) {
    if (territory === MISSING_TERRITORY) continue;
    const entry = byTerritory.get(territory) ?? { level: null, count: 0 };
    entry.count += 1;
    if (levelRank(level) > levelRank(entry.level)) entry.level = level;
    byTerritory.set(territory, entry);
  }
  const ranking = [...byTerritory.entries()]
    .map(([territory, entry]) => ({ territory, ...entry }))
    .sort(
      (a, b) =>
        levelRank(b.level) - levelRank(a.level) ||
        b.count - a.count ||
        a.territory.localeCompare(b.territory, 'es'),
    );

  const monthly = months.map((month) => {
    const counts: Record<Level | 'sin', number> = {
      Verde: 0,
      Amarillo: 0,
      Naranja: 0,
      Rojo: 0,
      sin: 0,
    };
    for (const { row, day } of dated)
      if (day?.slice(0, 7) === month) counts[recordedLevel(row) ?? 'sin'] += 1;
    return { month, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  });
  const current = monthly.at(-1)?.total ?? 0;
  const before = monthly.at(-2)?.total ?? 0;

  const recent = [...inPeriod].sort((a, b) => {
    const [da, db] = [alertDay(a) ?? '', alertDay(b) ?? ''];
    return db.localeCompare(da) || String(b._id).localeCompare(String(a._id));
  });

  return {
    total: inPeriod.length,
    previous,
    active,
    critical: active.filter((row) => recordedLevel(row) === 'Rojo').length,
    high: active.filter((row) => recordedLevel(row) === 'Naranja').length,
    sensitive: ranking.filter((r) => levelRank(r.level) >= levelRank('Naranja')).length,
    communities: ranking.length,
    missingTerritory: located.filter((l) => l.territory === MISSING_TERRITORY).length,
    undated: rows.filter((row) => !alertDay(row)).length,
    trend: {
      current,
      before,
      change: before ? Math.round(((current - before) / before) * 100) : null,
    },
    inPeriod,
    monthly,
    ranking,
    recent,
  };
};
