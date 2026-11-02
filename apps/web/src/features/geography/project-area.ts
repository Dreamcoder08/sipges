import type { ProjectLocation } from '@sipges/contracts';
import { type Extent, intersects } from './BaseMap.tsx';
import { SECHURA_EXTENT } from './sechura-base.ts';

export type ProjectArea = {
  /** Area the maps open on when no record carries a position. */
  readonly extent: Extent;
  /** Place named in map labels ("Mapa territorial de …"). */
  readonly place: string;
  /** Whether the Sechura districts, towns and localities belong on this project's maps. */
  readonly sechura: boolean;
  /** Option that clears the locality filter. */
  readonly all: string;
  /** Button that goes back to the whole area. */
  readonly home: string;
};

/**
 * The project's area (T19): its saved location, or the Sechura province for projects that have
 * none, so existing projects keep today's maps. The Sechura base layers only appear when the
 * location overlaps the province.
 */
export const projectArea = (location: ProjectLocation | null | undefined): ProjectArea =>
  location
    ? {
        extent: location.extent,
        place: location.place,
        sechura: intersects(location.extent, SECHURA_EXTENT),
        all: `Todo ${location.place}`,
        home: `Ver ${location.place}`,
      }
    : {
        extent: SECHURA_EXTENT,
        place: 'la provincia de Sechura',
        sechura: true,
        all: 'Toda la provincia',
        home: 'Ver toda la provincia',
      };
