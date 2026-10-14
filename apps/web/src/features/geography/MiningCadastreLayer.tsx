import { type Extent, svgX, svgY, UNITS_PER_DEGREE } from './BaseMap.tsx';

/** INGEMMET's public mining cadastre (GEOCATMIN), an ArcGIS MapServer in WGS 84. */
export const GEOCATMIN_ORIGIN = 'https://geocatmin.ingemmet.gob.pe';
export const GEOCATMIN_VIEWER = `${GEOCATMIN_ORIGIN}/geocatmin_v3/`;
const EXPORT = `${GEOCATMIN_ORIGIN}/arcgis/rest/services/SERV_CATASTRO_MINERO/MapServer/export`;

/** One transparent image of the cadastre for the view, in the same lon/lat space as the map. */
export const cadastreUrl = ([minLon, minLat, maxLon, maxLat]: Extent, size = 1024) => {
  const params = new URLSearchParams({
    bbox: [minLon, minLat, maxLon, maxLat].join(','),
    bboxSR: '4326',
    imageSR: '4326',
    size: `${size},${size}`,
    format: 'png32',
    transparent: 'true',
    layers: 'show:0',
    f: 'image',
  });
  return `${EXPORT}?${params}`;
};

/** Mining rights drawn by INGEMMET: blue titled, green in process, black extinguished. */
export const MiningCadastreLayer = ({ view }: { view: Extent }) => (
  <image
    aria-hidden="true"
    href={cadastreUrl(view)}
    x={svgX(view[0])}
    y={svgY(view[3])}
    width={(view[2] - view[0]) * UNITS_PER_DEGREE}
    height={(view[3] - view[1]) * UNITS_PER_DEGREE}
    preserveAspectRatio="none"
  />
);
