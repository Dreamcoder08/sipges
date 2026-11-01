import {
  DIMENSIONS,
  type DimensionCode,
  LEVELS,
  type Level,
  dimensionOf,
  foldText,
  severityLevel,
} from '../../shared/lib/text.ts';
import type { ModuleRecord } from './api.ts';

/** Records without Proyecto_ID belong to the legacy default project (app.py). */
const LEGACY_PROJECT = 'PRJ-SECHURA';
const CLOSED = new Set(['cerrada', 'cerrado', 'descartada', 'descartado']);

const projectOf = (record: ModuleRecord) =>
  typeof record['Proyecto_ID'] === 'string' && record['Proyecto_ID']
    ? record['Proyecto_ID']
    : LEGACY_PROJECT;
/** Charts follow the counters: records of the active project. */
const counted = (record: ModuleRecord, projectId: string) => projectOf(record) === projectId;

/** Open alerts of the active project by severity band (app.js loadDashboard). */
export const alertsByLevel = (alerts: readonly ModuleRecord[], projectId: string) => {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  for (const alert of alerts) {
    if (!counted(alert, projectId) || CLOSED.has(foldText(alert['Estado']))) continue;
    counts[severityLevel(alert['Nivel_Preliminar'] || alert['Nivel'])] += 1;
  }
  return counts;
};

/** Events of the active project by their main SIPGES dimension. */
export const eventsByDimension = (events: readonly ModuleRecord[], projectId: string) => {
  const counts = Object.fromEntries(DIMENSIONS.map((d) => [d, 0])) as Record<DimensionCode, number>;
  for (const event of events) {
    if (!counted(event, projectId)) continue;
    const code = dimensionOf(event['Dimension_Principal']);
    if (code) counts[code] += 1;
  }
  return counts;
};

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Events of the active project per month (from `Fecha`, YYYY-MM-DD), over the `span` months
 * that end with the latest dated event. Empty when no event has a usable date.
 */
export const eventsByMonth = (events: readonly ModuleRecord[], projectId: string, span = 6) => {
  const counts = new Map<number, number>();
  for (const event of events) {
    if (!counted(event, projectId)) continue;
    const match = /^(\d{4})-(\d{2})/.exec(String(event['Fecha'] ?? ''));
    if (!match) continue;
    const index = Number(match[1]) * 12 + Number(match[2]) - 1;
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  if (!counts.size) return [];
  const last = Math.max(...counts.keys());
  return Array.from({ length: span }, (_, i) => {
    const index = last - span + 1 + i;
    const year = Math.floor(index / 12);
    const month = index % 12;
    return {
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      label: `${MONTHS[month]} ${String(year).slice(2)}`,
      value: counts.get(index) ?? 0,
    };
  });
};

const RANK: Readonly<Record<Level, number>> = { Rojo: 3, Naranja: 2, Amarillo: 1, Verde: 0 };
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const dateOf = (record: ModuleRecord) => text(record['Fecha']);

/** One line of the phone "Hoy" view: what it is, when, and where to open it. */
export type TodayItem = { id: string; title: string; date: string };

/**
 * Open alerts of the active project that need attention first (docs/adr/0015): highest band,
 * then most recent. Green alerts are left out; they do not need action today.
 */
export const criticalAlerts = (
  alerts: readonly ModuleRecord[],
  projectId: string,
  limit = 3,
): (TodayItem & { level: Level })[] =>
  alerts
    .filter((a) => counted(a, projectId) && !CLOSED.has(foldText(a['Estado'])))
    .map((a) => ({
      id: a._id,
      title: text(a['Causa']) || 'Alerta sin causa documentada',
      date: dateOf(a),
      level: severityLevel(a['Nivel_Preliminar'] || a['Nivel']),
    }))
    .filter((a) => a.level !== 'Verde')
    .sort((x, y) => RANK[y.level] - RANK[x.level] || y.date.localeCompare(x.date))
    .slice(0, limit);

/** Latest real events of the active project, newest first; undated ones go last. */
export const recentEvents = (
  events: readonly ModuleRecord[],
  projectId: string,
  limit = 3,
): (TodayItem & { dimension: DimensionCode | null })[] =>
  events
    .filter((e) => counted(e, projectId))
    .map((e) => ({
      id: e._id,
      title: text(e['Descripcion_Hecho']) || 'Evento sin descripción',
      date: dateOf(e),
      dimension: dimensionOf(e['Dimension_Principal']),
    }))
    .sort((x, y) => y.date.localeCompare(x.date))
    .slice(0, limit);

/**
 * Events of the active project dated in the last seven days (today included), newest first.
 * `total` counts all of them; `items` keeps the first `limit` for the briefing.
 */
export const eventsThisWeek = (
  events: readonly ModuleRecord[],
  projectId: string,
  now: Date,
  limit = 3,
) => {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const week = recentEvents(events, projectId, Number.POSITIVE_INFINITY).filter(
    (event) => event.date.slice(0, 10) >= from && event.date.slice(0, 10) <= to,
  );
  return { total: week.length, items: week.slice(0, limit) };
};
