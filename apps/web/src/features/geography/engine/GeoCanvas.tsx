import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import {
  type LngLatBoundsLike,
  Map as MapLibreMap,
  type StyleSpecification,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { Extent } from '../BaseMap.tsx';
// Not from concessions.ts: that module pulls in the contracts, and sharing them with this
// chunk would move zod out of the entry chunk, ahead of its jitless (CSP) configuration.
import { legendOf } from '../legend.ts';
import { SECHURA_DISTRICTS } from '../sechura-base.ts';
import { BASEMAPS, type Basemap } from '../TileLayer.tsx';
import frame from '../MapFrame.module.css';
import type { CanvasConcession, CanvasPoint, Focus } from './types.ts';
import styles from './GeoCanvas.module.css';

// The worker is a same-origin module, so the strict CSP needs no blob: workers.
setWorkerUrl(workerUrl);

/** The same tile services as the SVG map (TileLayer), as MapLibre URL templates. */
const TEMPLATES: Readonly<Record<Exclude<Basemap, 'ninguno'>, string>> = {
  satelite: BASEMAPS.satelite.url(0, 0, 0).replace('/0/0/0.', '/{z}/{y}/{x}.'),
  calles: BASEMAPS.calles.url(0, 0, 0).replace('/0/0/0.', '/{z}/{x}/{y}.'),
};

/** Raster basemap only; everything MASCLI draws lives in deck.gl layers above it. */
export const styleFor = (basemap: Basemap): StyleSpecification => ({
  version: 8,
  sources:
    basemap === 'ninguno'
      ? {}
      : {
          base: {
            type: 'raster',
            tiles: [TEMPLATES[basemap]],
            tileSize: 256,
            maxzoom: BASEMAPS[basemap].maxZoom,
          },
        },
  layers: [
    { id: 'fondo', type: 'background', paint: { 'background-color': '#e9eef3' } },
    ...(basemap === 'ninguno'
      ? []
      : [{ id: 'base', type: 'raster' as const, source: 'base', paint: {} }]),
  ],
});

const DISTRICTS = {
  type: 'FeatureCollection' as const,
  features: SECHURA_DISTRICTS.map((d) => ({
    type: 'Feature' as const,
    properties: { name: d.name },
    geometry: { type: 'Polygon' as const, coordinates: [d.ring.map(([x, y]) => [x, y])] },
  })),
};

const ALPHA = { observado: 235, estimado: 120, escenario: 0 } as const;
const RADIUS = { current: 10, normal: 7, dim: 5 } as const;

/**
 * MapLibre GL JS basemap with a deck.gl overlay (ODD geospatial-timeline T2, ADR 0017): smooth
 * pan and pinch on the GPU, concessions as selectable polygons, records as points styled by
 * dimension and information state. The component owns no data: it draws what it is given and
 * reports clicks and the settled view.
 */
const GeoCanvas = ({
  basemap,
  home,
  homeLabel,
  label,
  points,
  concessions,
  selectedPoint,
  selectedConcession,
  focus,
  onSelectPoint,
  onSelectConcession,
  onView,
  onFailure,
}: {
  basemap: Basemap;
  home: Extent;
  homeLabel: string;
  label: string;
  points: readonly CanvasPoint[];
  concessions: readonly CanvasConcession[];
  selectedPoint: string;
  selectedConcession: string;
  focus: Focus | null;
  onSelectPoint: (id: string) => void;
  onSelectConcession: (code: string) => void;
  onView: (extent: Extent) => void;
  onFailure: () => void;
}) => {
  const hint = useId();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const handlers = useRef({ onSelectPoint, onSelectConcession, onView, onFailure });
  useLayoutEffect(() => {
    handlers.current = { onSelectPoint, onSelectConcession, onView, onFailure };
  });
  const bounds = (extent: Extent): LngLatBoundsLike => [
    [extent[0], extent[1]],
    [extent[2], extent[3]],
  ];
  const initial = useRef({ home, basemap });

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: node,
        style: styleFor(initial.current.basemap),
        bounds: bounds(initial.current.home),
        fitBoundsOptions: { padding: 24 },
        attributionControl: false,
        maxZoom: 18,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        renderWorldCopies: false,
      });
    } catch {
      handlers.current.onFailure();
      return;
    }
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.disableRotation();
    instance.getCanvas().setAttribute('aria-describedby', hint);
    const report = () => {
      const b = instance.getBounds();
      handlers.current.onView([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    // A basemap tile that fails (offline, blocked host) leaves the background and the MASCLI
    // layers; MapLibre would otherwise log every failed tile as a console error.
    instance.on('error', () => undefined);
    instance.on('load', report);
    instance.on('moveend', report);
    // A lost GPU context leaves a blank canvas; the SVG map takes over instead.
    instance.on('webglcontextlost', () => handlers.current.onFailure());
    const deck = new MapboxOverlay({ interleaved: false, layers: [] });
    instance.addControl(deck);
    map.current = instance;
    overlay.current = deck;
    return () => {
      overlay.current = null;
      map.current = null;
      instance.remove();
    };
  }, [hint]);

  useEffect(() => {
    map.current?.setStyle(styleFor(basemap));
  }, [basemap]);

  const homeKey = home.join(',');
  useEffect(() => {
    map.current?.fitBounds(bounds(home), { padding: 24, duration: 600 });
    // `homeKey` stands for the four numbers of `home`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeKey]);

  useEffect(() => {
    if (!focus) return;
    const current = map.current;
    if (!current) return;
    if (focus.extent) current.fitBounds(bounds(focus.extent), { padding: 48, duration: 700 });
    else if (focus.at)
      current.flyTo({
        center: [focus.at[0], focus.at[1]],
        zoom: Math.max(current.getZoom(), focus.zoom ?? 12),
        duration: 700,
        essential: true,
      });
  }, [focus]);

  useEffect(() => {
    overlay.current?.setProps({
      getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
      layers: [
        new GeoJsonLayer({
          id: 'distritos',
          data: DISTRICTS,
          stroked: true,
          filled: false,
          getLineColor: [23, 54, 93, 150],
          lineWidthMinPixels: 1,
        }),
        new GeoJsonLayer<{ code: string; legend: string }>({
          id: 'concesiones',
          data: {
            type: 'FeatureCollection',
            features: concessions.map((c) => ({
              type: 'Feature',
              properties: { code: c.code, legend: c.legend },
              geometry: c.geometry,
            })),
          },
          pickable: true,
          stroked: true,
          filled: true,
          getFillColor: (f) => [
            ...legendOf(f.properties.legend).color,
            f.properties.code === selectedConcession ? 90 : 28,
          ],
          getLineColor: (f) =>
            f.properties.code === selectedConcession
              ? [15, 37, 65, 255]
              : [...legendOf(f.properties.legend).color, 255],
          getLineWidth: (f) => (f.properties.code === selectedConcession ? 3 : 1.5),
          lineWidthUnits: 'pixels',
          updateTriggers: {
            getFillColor: selectedConcession,
            getLineColor: selectedConcession,
            getLineWidth: selectedConcession,
          },
          onClick: ({ object }) => {
            if (object) handlers.current.onSelectConcession(object.properties.code);
          },
        }),
        new ScatterplotLayer<CanvasPoint>({
          id: 'registros',
          data: points,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          lineWidthUnits: 'pixels',
          getPosition: (p) => [p.at[0], p.at[1]],
          getRadius: (p) => (p.id === selectedPoint ? 12 : RADIUS[p.emphasis]),
          getFillColor: (p) => [...p.color, p.emphasis === 'dim' ? 70 : ALPHA[p.evidence]],
          getLineColor: (p) =>
            p.id === selectedPoint
              ? [23, 33, 43, 255]
              : p.evidence === 'escenario'
                ? [...p.color, 255]
                : [255, 255, 255, p.emphasis === 'dim' ? 120 : 255],
          getLineWidth: (p) => (p.id === selectedPoint || p.evidence === 'escenario' ? 3 : 2),
          updateTriggers: {
            getRadius: selectedPoint,
            getLineColor: selectedPoint,
            getLineWidth: selectedPoint,
          },
          onClick: ({ object }) => {
            if (object) handlers.current.onSelectPoint(object.id);
          },
        }),
      ],
    });
  }, [points, concessions, selectedPoint, selectedConcession]);

  const act = (action: 'in' | 'out' | 'home') => {
    const current = map.current;
    if (!current) return;
    if (action === 'home') current.fitBounds(bounds(home), { padding: 24, duration: 600 });
    else current.zoomTo(current.getZoom() + (action === 'in' ? 1 : -1));
  };
  const controls = [
    { label: 'Acercar', icon: 'plus', action: 'in' },
    { label: 'Alejar', icon: 'minus', action: 'out' },
    { label: homeLabel, icon: 'home', action: 'home' },
  ] as const;
  return (
    <div className={frame.wrap}>
      <div className={`${frame.frame} ${styles.frame}`}>
        <div
          ref={container}
          className={styles.canvas}
          role="region"
          aria-label={label}
          data-map-engine="maplibre"
        />
        <div className={frame.controls}>
          {controls.map((c) => (
            <button
              key={c.label}
              type="button"
              className={frame.control}
              aria-label={c.label}
              title={c.label}
              onClick={() => act(c.action)}
            >
              <Icon name={c.icon} />
            </button>
          ))}
        </div>
      </div>
      <p id={hint} className={frame.hint}>
        Arrastre o use dos dedos para mover el mapa y pellizque para acercar. Con el mapa
        seleccionado: flechas para mover y + / − para acercar. Los registros también se eligen desde
        la evolución temporal.
      </p>
    </div>
  );
};

export default GeoCanvas;
