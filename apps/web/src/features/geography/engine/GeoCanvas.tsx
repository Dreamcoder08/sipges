import { MapboxOverlay } from '@deck.gl/mapbox';
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import {
  type LngLatBoundsLike,
  Map as MapLibreMap,
  type StyleSpecification,
  setWorkerUrl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useResolvedTheme } from '../../../shared/lib/theme.ts';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { IconName } from '../../../shared/ui/icons.ts';
import type { Extent } from '../BaseMap.tsx';
// Not from concessions.ts: that module pulls in the contracts, and sharing them with this
// chunk would move zod out of the entry chunk, ahead of its jitless (CSP) configuration.
import { legendOf } from '../legend.ts';
import { SECHURA_DISTRICTS } from '../sechura-base.ts';
import { BASEMAPS, type Basemap } from '../TileLayer.tsx';
import frame from '../MapFrame.module.css';
import { labelSize, placeLabels } from './labels.ts';
import { paintColour, paintRgb } from './paint.ts';
import type { CanvasConcession, CanvasPoint, Focus } from './types.ts';
import styles from './GeoCanvas.module.css';

// The worker is a same-origin module, so the strict CSP needs no blob: workers.
setWorkerUrl(workerUrl);

/** The same tile services as the SVG map (TileLayer), as MapLibre URL templates. */
const TEMPLATES: Readonly<Record<Exclude<Basemap, 'ninguno'>, string>> = {
  satelite: BASEMAPS.satelite.url(0, 0, 0).replace('/0/0/0.', '/{z}/{y}/{x}.'),
  calles: BASEMAPS.calles.url(0, 0, 0).replace('/0/0/0.', '/{z}/{x}/{y}.'),
};

type Theme = 'light' | 'dark';

/**
 * Paint WebGL cannot read through var(): the colours come from the --map-* tokens (paint.ts);
 * the raster adjustments have no token. In the dark theme street tiles are inverted (brightness
 * min/max swapped, hues turned back) and imagery is dimmed, matching the SVG renderer's
 * --map-filter-* tokens (docs/adr/0019).
 */
const RASTER = {
  light: { calles: {}, satelite: {} },
  dark: {
    calles: {
      'raster-brightness-min': 0.92,
      'raster-brightness-max': 0.04,
      'raster-hue-rotate': 180,
      'raster-saturation': -0.4,
      'raster-contrast': -0.1,
    },
    satelite: { 'raster-brightness-max': 0.8, 'raster-saturation': -0.1 },
  },
} as const;

/** Deck.gl colours of the current theme, read when a layer is built. */
const overlayPaint = (theme: Theme) => ({
  selected: [...paintRgb('--map-outline-selected', theme), 255] as const,
  halo: paintRgb('--map-point-halo', theme),
});

const DISTRICTS = {
  type: 'FeatureCollection' as const,
  features: SECHURA_DISTRICTS.map((d) => ({
    type: 'Feature' as const,
    properties: { name: d.name },
    geometry: { type: 'Polygon' as const, coordinates: [d.ring.map(([x, y]) => [x, y])] },
  })),
};

/**
 * The raster basemap and the district outlines; everything else SIPGES draws lives in deck.gl
 * layers above it. The outlines are a MapLibre line layer, not a deck.gl PathLayer: they are
 * static, and the PathLayer's first draw blocked the page for ~700 ms on a software GPU every
 * time the 2D map opened (world-class-local T9).
 */
export const styleFor = (
  basemap: Basemap,
  theme: Theme = 'light',
  showDistricts = false,
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
    ...(showDistricts ? { distritos: { type: 'geojson' as const, data: DISTRICTS } } : {}),
  },
  layers: [
    {
      id: 'fondo',
      type: 'background',
      paint: { 'background-color': paintColour('--map-bg', theme) },
    },
    ...(basemap === 'ninguno'
      ? []
      : [{ id: 'base', type: 'raster' as const, source: 'base', paint: RASTER[theme][basemap] }]),
    ...(showDistricts
      ? [
          {
            id: 'distritos',
            type: 'line' as const,
            source: 'distritos',
            paint: {
              'line-color': paintColour('--map-district-line', theme),
              'line-opacity': 150 / 255,
              'line-width': 1,
            },
          },
        ]
      : []),
  ],
});

const ALPHA = { observado: 235, estimado: 120, escenario: 0 } as const;
// Wide enough for the list number the marker carries (up to three digits).
const RADIUS = { current: 13, normal: 11, dim: 9 } as const;

/**
 * MapLibre GL JS basemap with a deck.gl overlay (ODD geospatial-timeline T2, ADR 0017): smooth
 * pan and pinch on the GPU, concessions as selectable polygons, records as points styled by
 * dimension and information state. The component owns no data: it draws what it is given and
 * reports clicks and the settled view. «Vista 3D» hands the view to the CesiumJS terrain engine
 * (ODD territorial-3d), which the page loads in its place.
 */
const GeoCanvas = ({
  hidden = false,
  basemap,
  home,
  homeLabel,
  showDistricts = true,
  label,
  points,
  concessions,
  selectedPoint,
  selectedConcession,
  focus,
  onView3d,
  onSelectPoint,
  onSelectConcession,
  onView,
  onFailure,
}: {
  /**
   * The page keeps the map mounted but hidden while the 3D view is open, so going back does not
   * re-create the WebGL map. While hidden the camera stays put; shown again, it frames `home`
   * and then `focus`, as a newly created map would.
   */
  hidden?: boolean;
  basemap: Basemap;
  home: Extent;
  homeLabel: string;
  /** False outside the Sechura province: its district outlines are not drawn. */
  showDistricts?: boolean;
  label: string;
  points: readonly CanvasPoint[];
  concessions: readonly CanvasConcession[];
  selectedPoint: string;
  selectedConcession: string;
  focus: Focus | null;
  /** Switches to the 3D terrain view; the button only shows when this is given. */
  onView3d?: () => void;
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
  const initial = useRef({ home, basemap, theme, showDistricts });
  // Zoom in quarter steps, rounded down: markers are never closer than the numbers assume.
  const [labelZoom, setLabelZoom] = useState<number | null>(null);

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container: node,
        style: styleFor(
          initial.current.basemap,
          initial.current.theme,
          initial.current.showDistricts,
        ),
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
    // A basemap tile that fails (offline, blocked host) leaves the background and the SIPGES
    // layers; MapLibre would otherwise log every failed tile as a console error.
    instance.on('error', () => undefined);
    const zoomed = () => setLabelZoom(Math.floor(instance.getZoom() * 4) / 4);
    instance.on('load', zoomed);
    instance.on('zoom', zoomed);
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
    map.current?.setStyle(styleFor(basemap, theme, showDistricts));
  }, [basemap, theme, showDistricts]);

  const frameFocus = (current: MapLibreMap, target: Focus) => {
    if (target.extent) current.fitBounds(bounds(target.extent), { padding: 48, duration: 700 });
    else if (target.at)
      current.flyTo({
        center: [target.at[0], target.at[1]],
        zoom: Math.max(current.getZoom(), target.zoom ?? 12),
        duration: 700,
        essential: true,
      });
  };

  const homeKey = home.join(',');
  useEffect(() => {
    if (hidden) return;
    map.current?.fitBounds(bounds(home), { padding: 24, duration: 600 });
    // `homeKey` stands for the four numbers of `home`; `hidden` is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeKey]);

  useEffect(() => {
    const current = map.current;
    if (!focus || !current || hidden) return;
    frameFocus(current, focus);
    // A focus set while hidden is framed when the map is shown (the effect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Shown again after the 3D view: size the canvas to its container (it had none while hidden),
  // then frame what a newly created map would show.
  const wasHidden = useRef(hidden);
  useEffect(() => {
    const current = map.current;
    const shown = wasHidden.current && !hidden;
    wasHidden.current = hidden;
    if (!shown || !current) return;
    current.resize();
    current.fitBounds(bounds(home), { padding: 24, duration: 0 });
    if (focus) frameFocus(current, focus);
    // Runs on the hidden → shown change only; `home` and `focus` are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden]);

  useEffect(() => {
    const paint = overlayPaint(theme);
    const labelled = labelZoom === null ? null : placeLabels(points, labelZoom, selectedPoint);
    overlay.current?.setProps({
      getCursor: ({ isHovering }) => (isHovering ? 'pointer' : 'grab'),
      layers: [
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
        new ScatterplotLayer<CanvasPoint>({
          id: 'registros',
          data: points,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          lineWidthUnits: 'pixels',
          getPosition: (p) => [p.at[0], p.at[1]],
          getRadius: (p) => (p.id === selectedPoint ? 14 : RADIUS[p.emphasis]),
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
        // The number of the record's row in the list, drawn over its point.
        new TextLayer<CanvasPoint>({
          id: 'numeros',
          // Only numbers that clear each other (labels.ts); none before the zoom is known.
          data: points.filter((p) => labelled?.has(p.id)),
          getPosition: (p) => [p.at[0], p.at[1]],
          getText: (p) => p.label ?? '',
          characterSet: '0123456789',
          getSize: (p) => labelSize(p.label ?? ''),
          fontWeight: 800,
          fontSettings: { sdf: true },
          getColor: [...paint.selected],
          outlineWidth: 3,
          outlineColor: [...paint.halo, 255],
          updateTriggers: { getColor: theme },
        }),
      ],
    });
  }, [points, concessions, selectedPoint, selectedConcession, theme, labelZoom]);

  type Action = 'in' | 'out' | 'home' | '3d';
  const act = (action: Action) => {
    const current = map.current;
    if (!current) return;
    if (action === '3d') onView3d?.();
    else if (action === 'home') current.fitBounds(bounds(home), { padding: 24, duration: 600 });
    else current.zoomTo(current.getZoom() + (action === 'in' ? 1 : -1));
  };
  const controls: { label: string; icon: IconName; action: Action }[] = [
    { label: 'Acercar', icon: 'plus', action: 'in' },
    { label: 'Alejar', icon: 'minus', action: 'out' },
    { label: homeLabel, icon: 'home', action: 'home' },
  ];
  if (onView3d) controls.push({ label: 'Vista 3D', icon: 'cube', action: '3d' });
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
              aria-pressed={c.action === '3d' ? false : undefined}
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
