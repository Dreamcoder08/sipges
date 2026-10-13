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
