import { MapboxOverlay } from '@deck.gl/mapbox';
import { ColumnLayer, GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { type LngLatBoundsLike, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useResolvedTheme } from '../../../shared/lib/theme.ts';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { IconName } from '../../../shared/ui/icons.ts';
import type { Extent } from '../BaseMap.tsx';
// Not from concessions.ts: that module pulls in the contracts, and sharing them with this
// chunk would move zod out of the entry chunk, ahead of its jitless (CSP) configuration.
import { legendOf } from '../legend.ts';
import { SECHURA_DISTRICTS } from '../sechura-base.ts';
import type { Basemap } from '../TileLayer.tsx';
import frame from '../MapFrame.module.css';
import { type CanvasColumn, columnsOf, metresPerRecord } from './columns.ts';
import { PAINT, styleFor } from './style.ts';
import type { CanvasConcession, CanvasPoint, Focus } from './types.ts';
import styles from './GeoCanvas.module.css';

// The worker is a same-origin module, so the strict CSP needs no blob: workers.
setWorkerUrl(workerUrl);

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
/** Camera of the 3D view: tilted enough to read heights, still showing the ground. */
const TILT = { pitch: 55, bearing: -20 } as const;

/**
 * MapLibre GL JS basemap with a deck.gl overlay (ODD geospatial-timeline T2, ADR 0017): smooth
 * pan and pinch on the GPU, concessions as selectable polygons, records as points styled by
 * dimension and information state. The component owns no data: it draws what it is given and
 * reports clicks and the settled view. In the 3D view (ODD territorial-3d) the map tilts and
 * rotates, and the documented records of each cell rise as a column as tall as their count.
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
  view3d = false,
  onView3d,
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
  /** Tilted view with record columns; rotation and tilt gestures only work here. */
  view3d?: boolean;
  onView3d?: (on: boolean) => void;
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
  const theme = useResolvedTheme();
  const paint = PAINT[theme];
  const initial = useRef({ home, basemap, theme });
  const [scale, setScale] = useState(() => metresPerRecord(10, -5.5));

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: node,
        style: styleFor(initial.current.basemap, initial.current.theme),
        bounds: bounds(initial.current.home),
        fitBoundsOptions: { padding: 24 },
        attributionControl: false,
        maxZoom: 18,
        dragRotate: false,
        touchPitch: false,
        maxPitch: 70,
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
    const zoomed = () => setScale(metresPerRecord(instance.getZoom(), instance.getCenter().lat));
    instance.on('load', zoomed);
    instance.on('zoomend', zoomed);
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

  const tilted = useRef(false);
  useEffect(() => {
    const current = map.current;
    if (!current || tilted.current === view3d) return;
    tilted.current = view3d;
    const gestures = view3d ? 'enable' : 'disable';
    current.dragRotate[gestures]();
    current.touchPitch[gestures]();
    current.touchZoomRotate[view3d ? 'enableRotation' : 'disableRotation']();
    current.keyboard[view3d ? 'enableRotation' : 'disableRotation']();
    current.easeTo({ ...(view3d ? TILT : { pitch: 0, bearing: 0 }), duration: 700 });
  }, [view3d]);

  const columns = useMemo(() => (view3d ? columnsOf(points) : []), [points, view3d]);

  useEffect(() => {
    map.current?.setStyle(styleFor(basemap, theme, view3d));
  }, [basemap, theme, view3d]);

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
          getLineColor: [...paint.district],
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
              ? [...paint.selected]
              : [...legendOf(f.properties.legend).color, 255],
          getLineWidth: (f) => (f.properties.code === selectedConcession ? 3 : 1.5),
          lineWidthUnits: 'pixels',
          updateTriggers: {
            getFillColor: selectedConcession,
            getLineColor: [selectedConcession, theme],
            getLineWidth: selectedConcession,
          },
          onClick: ({ object }) => {
            if (object) handlers.current.onSelectConcession(object.properties.code);
          },
        }),
        new ColumnLayer<CanvasColumn>({
          id: 'columnas',
          data: columns,
          visible: view3d,
          extruded: true,
          diskResolution: 16,
          radius: 9,
          radiusUnits: 'pixels',
          getPosition: (c) => [c.at[0], c.at[1]],
          getElevation: (c) => c.count,
          elevationScale: scale,
          // Solid when every record of the cell has explicit coordinates, lighter otherwise.
          getFillColor: (c) => [
            ...c.color,
            c.observed === c.count ? ALPHA.observado : ALPHA.estimado,
          ],
        }),
        new ScatterplotLayer<CanvasPoint>({
          id: 'registros',
          // Drawn over the columns, so every record stays visible and selectable in 3D.
          parameters: { depthCompare: 'always' },
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
              ? [...paint.selected]
              : p.evidence === 'escenario'
                ? [...p.color, 255]
                : [...paint.halo, p.emphasis === 'dim' ? 120 : 255],
          getLineWidth: (p) => (p.id === selectedPoint || p.evidence === 'escenario' ? 3 : 2),
          updateTriggers: {
            getRadius: selectedPoint,
            getLineColor: [selectedPoint, theme],
            getLineWidth: selectedPoint,
          },
          onClick: ({ object }) => {
            if (object) handlers.current.onSelectPoint(object.id);
          },
        }),
      ],
    });
  }, [
    points,
    columns,
    scale,
    view3d,
    concessions,
    selectedPoint,
    selectedConcession,
    paint,
    theme,
  ]);

  type Action = 'in' | 'out' | 'home' | 'tilt' | 'north';
  const act = (action: Action) => {
    const current = map.current;
    if (!current) return;
    if (action === 'tilt') onView3d?.(!view3d);
    else if (action === 'north') current.easeTo({ bearing: 0, duration: 500 });
    else if (action === 'home') current.fitBounds(bounds(home), { padding: 24, duration: 600 });
    else current.zoomTo(current.getZoom() + (action === 'in' ? 1 : -1));
  };
  const controls: { label: string; icon: IconName; action: Action }[] = [
    { label: 'Acercar', icon: 'plus', action: 'in' },
    { label: 'Alejar', icon: 'minus', action: 'out' },
    { label: homeLabel, icon: 'home', action: 'home' },
  ];
  if (onView3d) {
    controls.push({ label: 'Vista 3D', icon: 'cube', action: 'tilt' });
    if (view3d) controls.push({ label: 'Norte arriba', icon: 'compass', action: 'north' });
  }
  return (
    <div className={frame.wrap}>
      <div className={`${frame.frame} ${styles.frame}`}>
        <div
          ref={container}
          className={styles.canvas}
          role="region"
          aria-label={label}
          data-map-engine="maplibre"
          data-map-view={view3d ? '3d' : '2d'}
        />
        <div className={frame.controls}>
          {controls.map((c) => (
            <button
              key={c.label}
              type="button"
              className={frame.control}
              aria-label={c.label}
              title={c.label}
              aria-pressed={c.action === 'tilt' ? view3d : undefined}
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
        {view3d
          ? ' En 3D: arrastre con el botón derecho o con dos dedos para girar e inclinar; Mayús + flechas con el mapa seleccionado.'
          : ''}
      </p>
    </div>
  );
};

export default GeoCanvas;
