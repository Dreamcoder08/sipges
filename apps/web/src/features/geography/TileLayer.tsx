import { useLayoutEffect, useRef, useState } from 'react';
import { type Extent, svgX, svgY, UNITS_PER_DEGREE } from './BaseMap.tsx';

export type Basemap = 'satelite' | 'calles' | 'ninguno';

type Source = {
  label: string;
  url: (z: number, x: number, y: number) => string;
  /** Deepest level the service draws; closer views stretch these tiles. */
  maxZoom: number;
  attribution: { text: string; href: string };
};

/**
 * Raster basemaps (docs/adr/0006 addenda). Streets: public OSM tiles. Satellite: EOX's
 * Sentinel-2 cloudless 2020 mosaic (CC BY-NC-SA 4.0, about 10 m per pixel), no key or token.
 */
export const BASEMAPS: Record<Exclude<Basemap, 'ninguno'>, Source> = {
  satelite: {
    label: 'Satélite',
    url: (z, x, y) =>
      `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`,
    maxZoom: 14,
    attribution: {
      text: 'Sentinel-2 cloudless 2020 de EOX IT Services GmbH (contiene datos modificados de Copernicus Sentinel 2020)',
      href: 'https://s2maps.eu',
    },
  },
  calles: {
    label: 'Calles',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxZoom: 17,
    attribution: {
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    },
  },
};

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
};
const xToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const yToLat = (y: number, z: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** Share of the view loaded beyond each edge, so a drag reveals imagery, not blank ground. */
const MARGIN = 0.25;

type Tile = { key: string; href: string; x: number; y: number; width: number; height: number };

/** Tiles covering `view` plus a margin, at about four tiles across the view. */
export const tilesFor = (view: Extent, source: Source) => {
  const [minLon, minLat, maxLon, maxLat] = view;
  const padLon = (maxLon - minLon) * MARGIN;
  const padLat = (maxLat - minLat) * MARGIN;
  const zoom = Math.max(
    3,
    Math.min(source.maxZoom, Math.round(Math.log2((360 * 4) / (maxLon - minLon)))),
  );
  const x0 = Math.floor(lonToX(minLon - padLon, zoom));
  const x1 = Math.floor(lonToX(maxLon + padLon, zoom));
  const y0 = Math.floor(latToY(maxLat + padLat, zoom));
  const y1 = Math.floor(latToY(minLat - padLat, zoom));
  const tiles: Tile[] = [];
  for (let x = x0; x <= x1; x += 1)
    for (let y = y0; y <= y1; y += 1) {
      const west = xToLon(x, zoom);
      const east = xToLon(x + 1, zoom);
      const north = yToLat(y, zoom);
      const south = yToLat(y + 1, zoom);
      tiles.push({
        key: `${zoom}/${x}/${y}`,
        href: source.url(zoom, x, y),
        x: svgX(west),
        y: svgY(north),
        width: (east - west) * UNITS_PER_DEGREE,
        height: (north - south) * UNITS_PER_DEGREE,
      });
    }
  return { zoom, tiles };
};

/**
 * Basemap tiles under a lon/−lat SVG. Each tile is placed by its own geographic bounds; near
 * the equator the Mercator stretch inside one tile is negligible for orientation use. When the
 * zoom level changes, the previous level's loaded tiles stay underneath until the new ones
 * arrive, so zooming never flashes an empty map.
 */
export const TileLayer = ({ view, basemap = 'calles' }: { view: Extent; basemap?: Basemap }) => {
  const source = basemap === 'ninguno' ? undefined : BASEMAPS[basemap];
  const { zoom, tiles } = source ? tilesFor(view, source) : { zoom: 0, tiles: [] };
  const level = `${basemap}/${zoom}`;
  const loaded = useRef(new Set<string>());
  const shown = useRef(tiles);
  const [backdrop, setBackdrop] = useState<Tile[]>([]);

  // On a new level, the loaded tiles of the one before (still in `shown`) become the backdrop.
  useLayoutEffect(() => {
    const previous = shown.current.filter((t) => loaded.current.has(t.href));
    setBackdrop(basemap !== 'ninguno' && previous.length ? previous : []);
    // `level` alone decides when the backdrop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);
  useLayoutEffect(() => {
    shown.current = tiles;
  });

  const settle = (href: string) => {
    loaded.current.add(href);
    if (backdrop.length && tiles.every((t) => loaded.current.has(t.href))) setBackdrop([]);
  };
  const image = (t: Tile, onDone?: () => void) => (
    <image
      key={t.key}
      href={t.href}
      x={t.x}
      y={t.y}
      width={t.width}
      height={t.height}
      preserveAspectRatio="none"
      onLoad={onDone}
      onError={onDone}
    />
  );
  return (
    <g aria-hidden="true">
      {backdrop.length ? <g>{backdrop.map((t) => image(t))}</g> : null}
      {tiles.map((t) => image(t, () => settle(t.href)))}
    </g>
  );
};
