import { type Extent, svgX, svgY, UNITS_PER_DEGREE } from './BaseMap.tsx';

/** Public OSM raster tiles; normal browser caching and origin referrer apply. */
const tileUrl = (z: number, x: number, y: number) =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

export const TILE_ATTRIBUTION = '© OpenStreetMap contributors';

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
};
const xToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const yToLat = (y: number, z: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/**
 * Basemap tiles under a lon/−lat SVG. Each tile is placed by its own geographic bounds;
 * near the equator the Mercator stretch inside one tile is negligible for orientation use.
 */
export const TileLayer = ({ view }: { view: Extent }) => {
  const [minLon, minLat, maxLon, maxLat] = view;
  // About four tiles across the view, within OSM's zoom range.
  const zoom = Math.max(3, Math.min(17, Math.round(Math.log2((360 * 4) / (maxLon - minLon)))));
  const x0 = Math.floor(lonToX(minLon, zoom));
  const x1 = Math.floor(lonToX(maxLon, zoom));
  const y0 = Math.floor(latToY(maxLat, zoom));
  const y1 = Math.floor(latToY(minLat, zoom));
  const tiles = [];
  for (let x = x0; x <= x1; x += 1)
    for (let y = y0; y <= y1; y += 1) {
      const west = xToLon(x, zoom);
      const east = xToLon(x + 1, zoom);
      const north = yToLat(y, zoom);
      const south = yToLat(y + 1, zoom);
      tiles.push(
        <image
          key={`${zoom}/${x}/${y}`}
          href={tileUrl(zoom, x, y)}
          x={svgX(west)}
          y={svgY(north)}
          width={(east - west) * UNITS_PER_DEGREE}
          height={(north - south) * UNITS_PER_DEGREE}
          preserveAspectRatio="none"
        />,
      );
    }
  return <g aria-hidden="true">{tiles}</g>;
};
