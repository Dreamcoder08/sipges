import type { StyleSpecification } from 'maplibre-gl';
import { BASEMAPS, type Basemap } from '../TileLayer.tsx';

/** The same tile services as the SVG map (TileLayer), as MapLibre URL templates. */
const TEMPLATES: Readonly<Record<Exclude<Basemap, 'ninguno'>, string>> = {
  satelite: BASEMAPS.satelite.url(0, 0, 0).replace('/0/0/0.', '/{z}/{y}/{x}.'),
  calles: BASEMAPS.calles.url(0, 0, 0).replace('/0/0/0.', '/{z}/{x}/{y}.'),
};

export type Theme = 'light' | 'dark';

/**
 * Open elevation tiles of the AWS Registry of Open Data (Mapzen terrain, Terrarium encoding),
 * drawn as hillshade under the 3D view. Shading only: the ground stays flat, so every record
 * keeps its true position (ADR 0026).
 */
export const RELIEF = {
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxZoom: 15,
  attribution: {
    text: 'Terrain Tiles (Mapzen, AWS Open Data; SRTM y otras fuentes)',
    href: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md',
  },
} as const;

/**
 * Paint WebGL cannot read from CSS tokens (docs/adr/0019). In the dark theme street tiles are
 * inverted (brightness min/max swapped, hues turned back) and imagery is dimmed, matching the
 * SVG renderer's --map-filter-* tokens.
 */
export const PAINT = {
  light: {
    background: '#e9eef3',
    calles: {},
    satelite: {},
    district: [23, 54, 93, 150],
    selected: [15, 37, 65, 255],
    halo: [255, 255, 255],
    relief: { 'hillshade-shadow-color': '#4a5563', 'hillshade-highlight-color': '#ffffff' },
  },
  dark: {
    background: '#0b0d10',
    calles: {
      'raster-brightness-min': 0.92,
      'raster-brightness-max': 0.04,
      'raster-hue-rotate': 180,
      'raster-saturation': -0.4,
      'raster-contrast': -0.1,
    },
    satelite: { 'raster-brightness-max': 0.8, 'raster-saturation': -0.1 },
    district: [201, 212, 223, 150],
    selected: [255, 255, 255, 255],
    halo: [0, 0, 0],
    relief: { 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#5b6574' },
  },
} as const;

/**
 * Raster basemap, and hillshade when `relief` is on; everything MASCLI draws lives in deck.gl
 * layers above it.
 */
export const styleFor = (
  basemap: Basemap,
  theme: Theme = 'light',
  relief = false,
): StyleSpecification => ({
  version: 8,
  sources: {
    ...(basemap === 'ninguno'
      ? {}
      : {
          base: {
            type: 'raster' as const,
            tiles: [TEMPLATES[basemap]],
            tileSize: 256,
            maxzoom: BASEMAPS[basemap].maxZoom,
          },
        }),
    ...(relief
      ? {
          relieve: {
            type: 'raster-dem' as const,
            tiles: [RELIEF.url],
            encoding: 'terrarium' as const,
            tileSize: 256,
            maxzoom: RELIEF.maxZoom,
          },
        }
      : {}),
  },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': PAINT[theme].background } },
    ...(basemap === 'ninguno'
      ? []
      : [{ id: 'base', type: 'raster' as const, source: 'base', paint: PAINT[theme][basemap] }]),
    ...(relief
      ? [
          {
            id: 'relieve',
            type: 'hillshade' as const,
            source: 'relieve',
            paint: { 'hillshade-exaggeration': 0.45, ...PAINT[theme].relief },
          },
        ]
      : []),
  ],
});
