import type { ModuleRecord } from '@mascli/contracts';
import { DIMENSIONS, foldText, type Level } from '../../../shared/lib/text.ts';

export const MISSING_TERRITORY = 'Sin territorio registrado';
const text = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const levels: Readonly<Record<string, Level>> = {
  verde: 'Verde',
  bajo: 'Verde',
  amarillo: 'Amarillo',
  atencion: 'Amarillo',
  naranja: 'Naranja',
  'medio-alto': 'Naranja',
  rojo: 'Rojo',
  critico: 'Rojo',
};
export const LEVEL_ORDER = ['Verde', 'Amarillo', 'Naranja', 'Rojo'] as const;
export const recordedLevel = (row: ModuleRecord): Level | null => {
  const key = foldText(
    text(Object.hasOwn(row, 'Nivel_Preliminar') ? row.Nivel_Preliminar : row.Nivel),
  );
  return Object.hasOwn(levels, key) ? (levels[key] ?? null) : null;
};
const recordedDimension = (value: unknown): string => {
  const code = text(value)
    .toUpperCase()
    .match(/^([GADNEI])(?:$|\s*[-–—]\s*)/)?.[1];
  return code ?? '?';
};

/** Only an exact, stored event reference can supply a territory absent from an alert. */
export const alertTerritory = (row: ModuleRecord, events: readonly ModuleRecord[] = []) => {
  for (const key of ['Territorio', 'Comunidad', 'Localidad', 'Distrito']) {
    const value = text(row[key]);
    if (value) return value;
  }
  const ref = text(row['Evento/Registro_Origen']);
  const matches = ref ? events.filter((e) => e._id === ref || text(e.ID_Evento) === ref) : [];
  if (matches.length === 1 && text(matches[0]?.Territorio)) return text(matches[0]?.Territorio);
  return MISSING_TERRITORY;
};

export type HeatCell = {
  dimension: string;
  territory: string;
  level: Level | null;
  unknown: number;
  rows: ModuleRecord[];
};
export const alertHeatmap = (
  rows: readonly ModuleRecord[],
  events: readonly ModuleRecord[] = [],
) => {
  const active = rows.filter(
    (row) =>
      !['cerrada', 'cerrado', 'descartada', 'descartado'].includes(foldText(text(row.Estado))),
  );
  const located = active.map((row) => ({
    row,
    territory: alertTerritory(row, events),
    dimension: recordedDimension(row.Dimension),
  }));
  const territories = [...new Set(located.map((item) => item.territory))].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
  const dimensions: string[] = [...DIMENSIONS];
  if (located.some((item) => item.dimension === '?')) dimensions.push('?');
  const cells: HeatCell[] = [];
  for (const dimension of dimensions)
    for (const territory of territories) {
      const matching = located
        .filter((item) => item.dimension === dimension && item.territory === territory)
        .map((item) => item.row);
      const known = matching.map(recordedLevel).filter((level): level is Level => level !== null);
      const level = known.reduce<Level | null>(
        (max, next) => (!max || LEVEL_ORDER.indexOf(next) > LEVEL_ORDER.indexOf(max) ? next : max),
        null,
      );
      cells.push({
        dimension,
        territory,
        level,
        rows: matching,
        unknown: matching.length - known.length,
      });
    }
  return { active, territories, dimensions, cells };
};
