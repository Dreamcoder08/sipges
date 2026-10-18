import { GeographyServiceId } from '@mascli/contracts';
import { useEffect, useState } from 'react';
import { type Extent, svgX, svgY, UNITS_PER_DEGREE } from './BaseMap.tsx';

/** INGEMMET's public mining cadastre (GEOCATMIN), an ArcGIS MapServer in WGS 84. */
export const GEOCATMIN_ORIGIN = 'https://geocatmin.ingemmet.gob.pe';
export const GEOCATMIN_VIEWER = `${GEOCATMIN_ORIGIN}/geocatmin_v3/`;
const EXPORT = `${GEOCATMIN_ORIGIN}/arcgis/rest/services/SERV_CATASTRO_MINERO/MapServer/export`;

/** One transparent image of the cadastre for the view, in the same lon/lat space as the map. */
export const cadastreUrl = (
  [minLon, minLat, maxLon, maxLat]: Extent,
  size = 1024,
  layerId = 0,
  serviceId = 'SERV_CATASTRO_MINERO',
) => {
  const params = new URLSearchParams({
    bbox: [minLon, minLat, maxLon, maxLat].join(','),
    bboxSR: '4326',
    imageSR: '4326',
    size: `${size},${size}`,
    format: 'png32',
    transparent: 'true',
    layers: `show:${Number.isInteger(layerId) && layerId >= 0 ? layerId : 0}`,
    f: 'image',
  });
  return `${EXPORT.replace('SERV_CATASTRO_MINERO', GeographyServiceId.parse(serviceId))}?${params}`;
};

/** Time the view must stay still before a new image is requested (drags and pinches). */
export const SETTLE_MS = 300;

/**
 * Mining rights drawn by INGEMMET: blue titled, green in process, black extinguished. While the
 * reader drags or pinches, the last image stays in place and moves with the map; a new one is
 * requested once the view settles, so a gesture costs one request, not one per frame.
 */
export const MiningCadastreLayer = ({
  view,
  layerId = 0,
  serviceId = 'SERV_CATASTRO_MINERO',
  opacity = 1,
  onStatus,
}: {
  view: Extent;
  layerId?: number;
  serviceId?: string;
  opacity?: number;
  onStatus?: (status: 'loading' | 'loaded' | 'error') => void;
}) => {
  const key = view.join(',');
  const [shown, setShown] = useState(view);
  useEffect(() => {
    const timer = setTimeout(() => setShown(view), SETTLE_MS);
    return () => clearTimeout(timer);
    // `key` stands for the four numbers of `view`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const source = cadastreUrl(shown, 1024, layerId, serviceId);
  useEffect(() => {
    onStatus?.('loading');
    // The image source starts loading, independently of the callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  return (
    <image
      aria-hidden="true"
      href={source}
      opacity={Math.max(0, Math.min(1, opacity))}
      onLoad={() => onStatus?.('loaded')}
      onError={() => onStatus?.('error')}
      x={svgX(shown[0])}
      y={svgY(shown[3])}
      width={(shown[2] - shown[0]) * UNITS_PER_DEGREE}
      height={(shown[3] - shown[1]) * UNITS_PER_DEGREE}
      preserveAspectRatio="none"
    />
  );
};
