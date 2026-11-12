import type { Evidence } from '../evidence.ts';
import type { Concession } from '../concessions.ts';
import type { LonLat } from '../sechura-base.ts';
import type { Extent } from '../BaseMap.tsx';

/** A record as the map engine draws it. */
export type CanvasPoint = {
  readonly id: string;
  readonly at: LonLat;
  readonly color: readonly [number, number, number];
  readonly evidence: Evidence;
  /** Timeline playback: the month being shown, earlier months, or no playback. */
  readonly emphasis: 'current' | 'normal' | 'dim';
  /** The number the record carries in the map's list (the 3D columns do not show it). */
  readonly label?: string;
};

export type CanvasConcession = Pick<Concession, 'code' | 'legend' | 'geometry'>;

/** A one-off camera move; a new object moves the map again. */
export type Focus = { readonly at?: LonLat; readonly zoom?: number; readonly extent?: Extent };
