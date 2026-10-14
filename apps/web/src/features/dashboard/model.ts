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

/** Open alerts of the active project by severity band (app.js loadDashboard). */
export const alertsByLevel = (alerts: readonly ModuleRecord[], projectId: string) => {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  for (const alert of alerts) {
    if (projectOf(alert) !== projectId || CLOSED.has(foldText(alert['Estado']))) continue;
    counts[severityLevel(alert['Nivel_Preliminar'] || alert['Nivel'])] += 1;
  }
  return counts;
};

/** Events of the active project by their main MASCLI dimension. */
export const eventsByDimension = (events: readonly ModuleRecord[], projectId: string) => {
  const counts = Object.fromEntries(DIMENSIONS.map((d) => [d, 0])) as Record<DimensionCode, number>;
  for (const event of events) {
    if (projectOf(event) !== projectId) continue;
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
    if (projectOf(event) !== projectId) continue;
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
