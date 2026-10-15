import type { ModuleRecord } from '@mascli/contracts';
import { foldText } from '../../../shared/lib/text.ts';

export const INFLUENCE_BANDS = ['Alta', 'Media-alta', 'Media', 'Media-baja', 'Baja'] as const;
export const actorName = (row: ModuleRecord) =>
  String(row['Nombre_Actor/Organizacion'] || row.Nombre || row._id);
const key = (value: unknown) =>
  foldText(value)
    .trim()
    .replace(/[–—_]/g, '-')
    .replace(/\s*-\s*/g, '-');
const bandOf = (value: unknown) => {
  const index = INFLUENCE_BANDS.findIndex((band) => key(band) === key(value));
  return index < 0 ? null : index;
};
export type PositionTone = 'favor' | 'contra' | 'neutral' | 'expectante' | 'unknown';
export const positionTone = (value: unknown): PositionTone => {
  const text = key(value);
  if (['a favor', 'favorable'].includes(text)) return 'favor';
  if (['en contra', 'desfavorable', 'oposicion'].includes(text)) return 'contra';
  if (text === 'neutral') return 'neutral';
  if (text === 'expectante') return 'expectante';
  return 'unknown';
};
export type ActorGroup = { key: string; type: string; band: number | null; rows: ModuleRecord[] };
export const actorGroups = (rows: readonly ModuleRecord[]): ActorGroup[] => {
  const groups = new Map<string, ActorGroup>();
  for (const row of rows) {
    const type =
      typeof row.Tipo_Actor === 'string' && row.Tipo_Actor.trim()
        ? row.Tipo_Actor.trim()
        : 'Sin tipo registrado';
    const band = bandOf(row.Influencia);
    const id = JSON.stringify([type, band]);
    const group = groups.get(id) ?? { key: id, type, band, rows: [] };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()].sort(
    (a, b) => a.type.localeCompare(b.type, 'es') || (a.band ?? 9) - (b.band ?? 9),
  );
};
