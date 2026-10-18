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

/** Quadrants of the radial actor map, clockwise from the top-left corner. */
export const SECTORS = ['Gobierno', 'Privado', 'Sociedad civil', 'Academia'] as const;
export type Sector = (typeof SECTORS)[number];
const SECTOR_HINTS: readonly [Sector, readonly string[]][] = [
  ['Academia', ['academ', 'universi', 'investig', 'colegio profesional', 'cientific']],
  [
    'Privado',
    ['empresa', 'productiv', 'privad', 'comerci', 'camara', 'gremi', 'industri', 'minera'],
  ],
  [
    'Gobierno',
    [
      'gobierno',
      'autoridad',
      'institucion publica',
      'municipal',
      'ministerio',
      'estado',
      'regional',
      'prefect',
      'alcald',
      'fiscal',
      'policia',
    ],
  ],
  [
    'Sociedad civil',
    ['comun', 'social', 'sociedad civil', 'iglesia', 'padre', 'frente', 'ronda', 'sindicat'],
  ],
];
/** The recorded sector, else one inferred from the actor type and then the name. */
export const sectorOf = (row: ModuleRecord): { sector: Sector | null; inferred: boolean } => {
  const recorded = SECTORS.find((s) => key(s) === key(row.Sector));
  if (recorded) return { sector: recorded, inferred: false };
  for (const text of [key(row.Tipo_Actor), key(actorName(row))]) {
    const hit = SECTOR_HINTS.find(([, hints]) => hints.some((h) => text.includes(h)));
    if (hit) return { sector: hit[0], inferred: true };
  }
  if (key(row.Tipo_Actor).includes('institucion')) return { sector: 'Gobierno', inferred: true };
  return { sector: null, inferred: true };
};

/** Rings from the centre out, as in the reference stakeholder map. */
export const RINGS = ['Control', 'Influencia', 'Interés'] as const;
export const ringOf = (band: number | null) =>
  band === null ? 2 : band === 0 ? 0 : band <= 2 ? 1 : 2;

export type RelationStrength = 'fuerte' | 'debil' | null;
export type RelationDirection = 'proyecto' | 'actor' | 'ambos' | null;
export const relationOf = (row: ModuleRecord) => {
  const strength = key(row.Tipo_Relacion);
  const direction = key(row.Sentido_Relacion);
  return {
    strength: (strength.startsWith('fuerte')
      ? 'fuerte'
      : strength.startsWith('debil')
        ? 'debil'
        : null) as RelationStrength,
    direction: (direction.includes('ambos')
      ? 'ambos'
      : direction.includes('proyecto al actor')
        ? 'proyecto'
        : direction.includes('actor al proyecto')
          ? 'actor'
          : null) as RelationDirection,
  };
};

export const MAP = { width: 1100, height: 820, cx: 550, cy: 410, stretch: 1.3 } as const;
/** Ring boundaries in map radius units: centre, Control, Influencia, Interés. */
export const RING_EDGES = [62, 175, 282, 385] as const;
export const ringEdge = (index: number) => RING_EDGES[index] ?? RING_EDGES[3];
export const CARD = { width: 128, height: 32 } as const;
/** Target radius by influence band: higher influence sits closer to the centre. */
const BAND_RADIUS = [120, 205, 250, 318, 352] as const;
/** Cards that fit one sector of each ring at full size; busier maps draw smaller cards. */
const CAPACITY = [3, 6, 9] as const;
/** Angular range of each sector in radians (SVG angles, clockwise from the right). */
const SECTOR_RANGE: Record<Sector, readonly [number, number]> = {
  Gobierno: [Math.PI, 1.5 * Math.PI],
  Privado: [1.5 * Math.PI, 2 * Math.PI],
  'Sociedad civil': [0, 0.5 * Math.PI],
  Academia: [0.5 * Math.PI, Math.PI],
};
export const toPoint = (angle: number, radius: number) => ({
  x: MAP.cx + Math.cos(angle) * radius * MAP.stretch,
  y: MAP.cy + Math.sin(angle) * radius,
});
const toPolar = (x: number, y: number) => {
  const dx = (x - MAP.cx) / MAP.stretch;
  const dy = y - MAP.cy;
  let angle = Math.atan2(dy, dx);
  if (angle < 0) angle += 2 * Math.PI;
  return { angle, radius: Math.hypot(dx, dy) };
};

export type PlacedActor = {
  row: ModuleRecord;
  name: string;
  sector: Sector;
  sectorInferred: boolean;
  band: number | null;
  ring: number;
  tone: PositionTone;
  relation: ReturnType<typeof relationOf>;
  x: number;
  y: number;
};

/**
 * Places every actor in its sector and ring, then nudges overlapping cards apart without
 * leaving their ring or sector. Deterministic, so the map does not jump between renders.
 * Actors without a recognisable sector go to «Sociedad civil» with the sector marked as inferred.
 * `scale` shrinks every card when a sector ring holds more actors than fit at full size.
 */
export const layoutActors = (
  rows: readonly ModuleRecord[],
): { actors: PlacedActor[]; scale: number } => {
  const placed: (PlacedActor & { min: number; max: number; from: number; to: number })[] = [];
  const buckets = new Map<string, ModuleRecord[]>();
  const info = new Map<ModuleRecord, { sector: Sector; inferred: boolean; band: number | null }>();
  for (const row of rows) {
    const { sector, inferred } = sectorOf(row);
    const band = bandOf(row.Influencia);
    const entry = { sector: sector ?? 'Sociedad civil', inferred, band };
    info.set(row, entry);
    const id = `${entry.sector}/${ringOf(band)}`;
    buckets.set(id, [...(buckets.get(id) ?? []), row]);
  }
  let scale = 1;
  for (const [id, bucket] of buckets)
    scale = Math.min(scale, Math.sqrt((CAPACITY[Number(id.slice(-1))] ?? 9) / bucket.length));
  scale = Math.max(0.5, scale);
  for (const bucket of buckets.values()) {
    bucket.sort(
      (a, b) =>
        (info.get(a)?.band ?? 9) - (info.get(b)?.band ?? 9) ||
        actorName(a).localeCompare(actorName(b), 'es'),
    );
    bucket.forEach((row, index) => {
      const { sector, inferred, band } = info.get(row) as {
        sector: Sector;
        inferred: boolean;
        band: number | null;
      };
      const ring = ringOf(band);
      const [start, end] = SECTOR_RANGE[sector];
      const pad = 0.12 + (2 - ring) * 0.06;
      const from = start + pad;
      const to = end - pad;
      const angle = from + ((index + 0.5) * (to - from)) / bucket.length;
      const min = ringEdge(ring) + 8;
      const max = ringEdge(ring + 1) - 8;
      const base = BAND_RADIUS[band ?? 4] ?? BAND_RADIUS[4];
      const radius = Math.min(
        max,
        Math.max(min, base + (bucket.length > 3 ? (index % 2 ? 14 : -14) : 0)),
      );
      const point = toPoint(angle, radius);
      placed.push({
        row,
        name: actorName(row),
        sector,
        sectorInferred: inferred,
        band,
        ring,
        tone: positionTone(row.Posicion_Proyecto),
        relation: relationOf(row),
        ...point,
        min,
        max,
        from,
        to,
      });
    });
  }
  const gapX = (CARD.width + 6) * scale;
  const gapY = (CARD.height + 6) * scale;
  for (let step = 0; step < 200; step++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i] as PlacedActor;
        const b = placed[j] as PlacedActor;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ox = gapX - Math.abs(dx);
        const oy = gapY - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy * 1.4) {
          const push = (ox / 2) * (dx >= 0 ? 1 : -1) || ox / 2;
          a.x -= push;
          b.x += push;
        } else {
          const push = (oy / 2) * (dy >= 0 ? 1 : -1) || oy / 2;
          a.y -= push;
          b.y += push;
        }
      }
    }
    for (const actor of placed) {
      const polar = toPolar(actor.x, actor.y);
      const angle = Math.min(actor.to, Math.max(actor.from, polar.angle));
      const radius = Math.min(actor.max, Math.max(actor.min, polar.radius));
      Object.assign(actor, toPoint(angle, radius));
    }
    if (!moved) break;
  }
  return {
    actors: placed.map(({ min: _min, max: _max, from: _from, to: _to, ...actor }) => actor),
    scale,
  };
};
