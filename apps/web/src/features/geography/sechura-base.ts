/**
 * Base layer for the Sechura province (Piura, Peru): simplified district outlines.
 *
 * District geometry: peru_distrital_simple.geojson from github.com/juaneladio/peru-geojson
 * (derived from INEI district limits), Mozilla Public License 2.0 — this file stays under that
 * licence; see https://mozilla.org/MPL/2.0/. Coordinates are WGS 84 [longitude, latitude],
 * rounded to 4 decimals. The outlines are generalised for orientation only: they are not
 * official limits and must not be used for measurement.
 */

export type LonLat = readonly [number, number];

export type District = { readonly name: string; readonly ring: readonly LonLat[] };

export const SECHURA_DISTRICTS: readonly District[] = [
  {
    name: 'Sechura',
    ring: [
      [-80.7912, -5.4839],
      [-80.7684, -5.5128],
      [-80.7653, -5.5363],
      [-80.6259, -5.5989],
      [-80.5346, -5.6016],
      [-80.323, -5.6793],
      [-80.2912, -5.6779],
      [-80.2077, -5.7215],
      [-80.1091, -5.7878],
      [-80.053, -5.8112],
      [-80.1309, -5.8887],
      [-80.1989, -5.893],
      [-80.3274, -5.9474],
      [-80.3762, -6.007],
      [-80.6271, -6.3719],
      [-80.6271, -6.3721],
      [-80.7979, -6.289],
      [-80.9131, -6.1906],
      [-81.0916, -6.082],
      [-81.1493, -5.9812],
      [-81.1493, -5.8892],
      [-81.1224, -5.8422],
      [-81.0975, -5.8382],
      [-81.0684, -5.7857],
      [-81.0217, -5.8306],
      [-80.9431, -5.8457],
      [-80.8915, -5.8098],
      [-80.8612, -5.7497],
      [-80.8525, -5.6355],
      [-80.8826, -5.5479],
    ],
  },
  {
    name: 'Vice',
    ring: [
      [-80.7492, -5.4134],
      [-80.7571, -5.4445],
      [-80.7912, -5.4839],
      [-80.8826, -5.5479],
      [-80.9302, -5.4575],
      [-80.994, -5.3885],
      [-80.9615, -5.311],
    ],
  },
  {
    name: 'Bernal',
    ring: [
      [-80.7054, -5.4295],
      [-80.6353, -5.4504],
      [-80.6367, -5.4861],
      [-80.7017, -5.4772],
      [-80.7637, -5.493],
      [-80.7542, -5.4494],
      [-80.7216, -5.4214],
    ],
  },
  {
    name: 'Cristo Nos Valga',
    ring: [
      [-80.6367, -5.4861],
      [-80.568, -5.4867],
      [-80.5526, -5.4923],
      [-80.5346, -5.6016],
      [-80.6259, -5.5989],
      [-80.7653, -5.5363],
      [-80.7684, -5.5128],
      [-80.7637, -5.493],
      [-80.7017, -5.4772],
    ],
  },
  {
    name: 'Rinconada Llicuar',
    ring: [
      [-80.7571, -5.4445],
      [-80.7542, -5.4494],
      [-80.7637, -5.493],
      [-80.7684, -5.5128],
      [-80.7912, -5.4839],
    ],
  },
  {
    name: 'Bellavista de la Unión',
    ring: [
      [-80.7216, -5.4214],
      [-80.7542, -5.4494],
      [-80.7571, -5.4445],
      [-80.7492, -5.4134],
    ],
  },
];

/** Reference places (approximate town centres) and area labels. */
export const SECHURA_PLACES: readonly { name: string; at: LonLat; kind: 'town' | 'port' }[] = [
  { name: 'Sechura', at: [-80.8222, -5.5569], kind: 'town' },
  { name: 'Vice', at: [-80.7767, -5.4183], kind: 'town' },
  { name: 'Bernal', at: [-80.7428, -5.4597], kind: 'town' },
  { name: 'Bayóvar', at: [-81.06, -5.81], kind: 'port' },
];

export const SECHURA_LABELS: readonly { text: string; at: LonLat; kind: 'sea' | 'area' }[] = [
  { text: 'Océano Pacífico', at: [-81.32, -5.62], kind: 'sea' },
  { text: 'Bahía de Sechura', at: [-81.0, -5.66], kind: 'sea' },
  { text: 'Desierto de Sechura', at: [-80.45, -5.95], kind: 'area' },
];

/** [minLon, minLat, maxLon, maxLat] of the province outline. */
export const SECHURA_EXTENT = [-81.1493, -6.3721, -80.053, -5.311] as const;
