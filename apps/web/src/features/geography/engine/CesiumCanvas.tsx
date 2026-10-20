// Must run before CesiumJS resolves its workers and assets: they are served from /cesium/.
import './cesium-base.ts';
import type { Cartesian2 } from '@cesium/engine';
import {
  BoundingSphere,
  type Camera,
  Cartesian3,
  CesiumWidget,
  Color,
  Credit,
  CreditDisplay,
  CustomHeightmapTerrainProvider,
  Entity,
  HeadingPitchRange,
  HeightReference,
  ImageryLayer,
  Math as CesiumMath,
  Material,
  Matrix4,
  PolygonHierarchy,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
} from '@cesium/engine';
import '@cesium/engine/Source/Widget/CesiumWidget.css';
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useResolvedTheme } from '../../../shared/lib/theme.ts';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { IconName } from '../../../shared/ui/icons.ts';
import type { Extent } from '../BaseMap.tsx';
import { legendOf } from '../legend.ts';
import { type LonLat, SECHURA_DISTRICTS } from '../sechura-base.ts';
import { BASEMAPS, type Basemap } from '../TileLayer.tsx';
import frame from '../MapFrame.module.css';
import { columnsOf, COLUMN_RADIUS, METRES_PER_RECORD } from './columns.ts';
import { GRID, RELIEF, sampleHeights, sourceTile } from './terrarium.ts';
import type { CanvasConcession, CanvasPoint, Focus } from './types.ts';
import styles from './GeoCanvas.module.css';

/** Same tile services as the 2D map, as CesiumJS URL templates. */
const TEMPLATES: Readonly<Record<Exclude<Basemap, 'ninguno'>, string>> = {
  satelite: BASEMAPS.satelite.url(0, 0, 0).replace('/0/0/0.', '/{z}/{y}/{x}.'),
  calles: BASEMAPS.calles.url(0, 0, 0).replace('/0/0/0.', '/{z}/{x}/{y}.'),
};

const GLOBE = { light: '#e9eef3', dark: '#0b0d10' } as const;
const SELECTED = { light: '#0f2541', dark: '#ffffff' } as const;
const DISTRICT = { light: [23, 54, 93], dark: [201, 212, 223] } as const;
const ALPHA = { observado: 0.92, estimado: 0.47, escenario: 0 } as const;
const SIZE = { current: 20, normal: 14, dim: 10 } as const;
/** Camera of the 3D view: looking north-north-east, tilted enough to read the relief. */
const VIEW = { heading: CesiumMath.toRadians(-15), pitch: CesiumMath.toRadians(-38) };

const rgba = ([r, g, b]: readonly number[], alpha: number) =>
  new Color((r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255, alpha);
const ringPositions = (ring: readonly LonLat[]) =>
  Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]));
const polygons = (geometry: CanvasConcession['geometry']) =>
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;

/** Sphere around an extent, so the camera can frame it at any heading and tilt. */
const sphereOf = (extent: Extent) => {
  const centre = Cartesian3.fromDegrees((extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2);
  const corner = Cartesian3.fromDegrees(extent[0], extent[1]);
  return new BoundingSphere(centre, Math.max(Cartesian3.distance(centre, corner), 400));
};

/** Heights the no-basemap tint spans, in metres: Sechura's coast to the Illescas summits. */
const TINT_RANGE = [0, 600] as const;
const TINT_STOPS = {
  light: ['#eef0e2', '#d6e2b8', '#e3d39c', '#c9a477', '#94714f'],
  dark: ['#14211a', '#27402c', '#4a4a2c', '#5e4630', '#7a5c44'],
} as const;

/** Colour ramp texture for the globe when no basemap is shown, so the relief stays readable. */
const tint = (theme: 'light' | 'dark') => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 1;
  const context = canvas.getContext('2d');
  if (context) {
    const ramp = context.createLinearGradient(0, 0, 256, 0);
    TINT_STOPS[theme].forEach((color, i, all) => ramp.addColorStop(i / (all.length - 1), color));
    context.fillStyle = ramp;
    context.fillRect(0, 0, 256, 1);
  }
  return Material.fromType('ElevationRamp', {
    image: canvas,
    minimumHeight: TINT_RANGE[0],
    maximumHeight: TINT_RANGE[1],
  });
};

/** Frames an extent from above at the 3D view's heading and tilt. */
const frameExtent = (camera: Camera, extent: Extent, duration: number, heading = VIEW.heading) => {
  const sphere = sphereOf(extent);
  const offset = new HeadingPitchRange(heading, VIEW.pitch, sphere.radius * 2.6);
  if (duration) camera.flyToBoundingSphere(sphere, { offset, duration });
  else {
    camera.lookAt(sphere.center, offset);
    camera.lookAtTransform(Matrix4.IDENTITY);
  }
};

/**
 * Terrain from open Terrarium tiles, decoded in the browser. A tile that cannot be read (offline,
 * blocked host) is flat, and `onMissing` reports it once so the page can say so.
 */
const reliefTerrain = (onMissing: () => void) => {
  const cache = new Map<string, Promise<Uint8ClampedArray | null>>();
  const read = (z: number, x: number, y: number) => {
    const key = `${z}/${x}/${y}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = fetch(RELIEF.url(z, x, y))
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error('relieve'))))
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        const canvas = document.createElement('canvas');
        canvas.width = RELIEF.size;
        canvas.height = RELIEF.size;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, RELIEF.size, RELIEF.size).data;
      })
      .catch(() => null);
    cache.set(key, pending);
    if (cache.size > 200) cache.delete(cache.keys().next().value ?? key);
    return pending;
  };
  return new CustomHeightmapTerrainProvider({
    width: GRID,
    height: GRID,
    tilingScheme: new WebMercatorTilingScheme(),
    callback: async (x, y, level) => {
      const source = sourceTile(x, y, level);
      const pixels = await read(source.z, source.x, source.y);
      if (!pixels) {
        onMissing();
        return new Float32Array(GRID * GRID);
      }
      return sampleHeights(pixels, RELIEF.size, source);
    },
  });
};

/**
 * CesiumJS terrain view of the territorial map (ODD territorial-3d, ADR 0026): open elevation
 * as real relief, the basemap draped over it, concessions and records clamped to the ground,
 * and the documented records of each cell rising as a column as tall as their count. It owns
 * no data and reports clicks like the 2D engine; no Cesium ion service or token is used.
 */
const CesiumCanvas = ({
  basemap,
  home,
  homeLabel,
  label,
  points,
  concessions,
  selectedPoint,
  selectedConcession,
  focus,
  onExit,
  onSelectPoint,
  onSelectConcession,
  onReliefMissing,
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
  /** Back to the 2D map. */
  onExit: () => void;
  onSelectPoint: (id: string) => void;
  onSelectConcession: (code: string) => void;
  /** Some elevation tiles could not be read; that terrain is drawn flat. */
  onReliefMissing: () => void;
  onFailure: () => void;
}) => {
  const hint = useId();
  const container = useRef<HTMLDivElement>(null);
  const credits = useRef<HTMLDivElement>(null);
  const widget = useRef<CesiumWidget | null>(null);
  const handlers = useRef({ onSelectPoint, onSelectConcession, onReliefMissing, onFailure });
  useLayoutEffect(() => {
    handlers.current = { onSelectPoint, onSelectConcession, onReliefMissing, onFailure };
  });
  const theme = useResolvedTheme();
  const initial = useRef({ home, theme });

  useEffect(() => {
    const node = container.current;
    if (!node || !credits.current) return;
    let instance: CesiumWidget;
    let missing = false;
    // Cesium's default credit is the Cesium ion logo, drawn with an inline style the CSP
    // refuses; this view uses no ion service, so it credits the open-source engine instead.
    CreditDisplay.cesiumCredit = new Credit(
      '<a href="https://cesium.com/platform/cesiumjs/" target="_blank" rel="noreferrer">CesiumJS</a>',
      true,
    );
    try {
      instance = new CesiumWidget(node, {
        baseLayer: false,
        terrainProvider: reliefTerrain(() => {
          if (missing) return;
          missing = true;
          handlers.current.onReliefMissing();
        }),
        skyBox: false,
        skyAtmosphere: false,
        scene3DOnly: true,
        creditContainer: credits.current,
      });
    } catch {
      handlers.current.onFailure();
      return;
    }
    const { scene } = instance;
    scene.globe.depthTestAgainstTerrain = true;
    scene.globe.baseColor = Color.fromCssColorString(GLOBE[initial.current.theme]);
    scene.globe.showGroundAtmosphere = false;
    scene.verticalExaggeration = 1.5;
    scene.canvas.setAttribute('aria-describedby', hint);
    scene.renderError.addEventListener(() => handlers.current.onFailure());
    frameExtent(instance.camera, initial.current.home, 0);
    const clicks = new ScreenSpaceEventHandler(scene.canvas);
    clicks.setInputAction((event: { position: Cartesian2 }) => {
      const picked: unknown = scene.pick(event.position);
      const entity = (picked as { id?: unknown } | undefined)?.id;
      if (!(entity instanceof Entity)) return;
      // Ids are `p:<record>` and `c:<part>:<concession code>`.
      const [kind, ...rest] = entity.id.split(':');
      if (kind === 'p') handlers.current.onSelectPoint(rest.join(':'));
      else if (kind === 'c') handlers.current.onSelectConcession(rest.slice(1).join(':'));
    }, ScreenSpaceEventType.LEFT_CLICK);
    widget.current = instance;
    return () => {
      widget.current = null;
      clicks.destroy();
      instance.destroy();
    };
  }, [hint]);

  useEffect(() => {
    const instance = widget.current;
    if (!instance) return;
    instance.scene.globe.baseColor = Color.fromCssColorString(GLOBE[theme]);
    instance.imageryLayers.removeAll();
    // Without a basemap the ground is tinted by height; a basemap is draped as it is.
    instance.scene.globe.material = basemap === 'ninguno' ? tint(theme) : undefined;
    if (basemap !== 'ninguno') {
      const layer = new ImageryLayer(
        new UrlTemplateImageryProvider({
          url: TEMPLATES[basemap],
          maximumLevel: BASEMAPS[basemap].maxZoom,
          credit: BASEMAPS[basemap].attribution.text,
        }),
      );
      // The dark theme dims the basemap, as the 2D renderers do (docs/adr/0019).
      if (theme === 'dark') {
        layer.brightness = basemap === 'calles' ? 0.45 : 0.8;
        layer.saturation = 0.6;
      }
      instance.imageryLayers.add(layer);
    }
    instance.scene.requestRender();
  }, [basemap, theme]);

  const columns = useMemo(() => columnsOf(points), [points]);

  useEffect(() => {
    const instance = widget.current;
    if (!instance) return;
    const { entities } = instance;
    entities.suspendEvents();
    entities.removeAll();
    const selected = Color.fromCssColorString(SELECTED[theme]);
    for (const d of SECHURA_DISTRICTS)
      entities.add({
        polyline: {
          positions: ringPositions(d.ring),
          clampToGround: true,
          width: 1,
          material: rgba(DISTRICT[theme], 0.6),
        },
      });
    for (const c of concessions) {
      const color = legendOf(c.legend).color;
      const chosen = c.code === selectedConcession;
      for (const [part, [outer, ...holes]] of polygons(c.geometry).entries()) {
        if (!outer) continue;
        entities.add({
          id: `c:${part}:${c.code}`,
          polygon: {
            hierarchy: new PolygonHierarchy(
              ringPositions(outer),
              holes.map((hole) => new PolygonHierarchy(ringPositions(hole))),
            ),
            material: rgba(color, chosen ? 0.35 : 0.12),
          },
          polyline: {
            positions: ringPositions(outer),
            clampToGround: true,
            width: chosen ? 3 : 1.5,
            material: chosen ? selected : rgba(color, 1),
          },
        });
      }
    }
    for (const c of columns)
      entities.add({
        position: Cartesian3.fromDegrees(c.at[0], c.at[1], (c.count * METRES_PER_RECORD) / 2),
        cylinder: {
          length: c.count * METRES_PER_RECORD,
          topRadius: COLUMN_RADIUS,
          bottomRadius: COLUMN_RADIUS,
          heightReference: HeightReference.RELATIVE_TO_GROUND,
          // Solid when every record of the cell has explicit coordinates, lighter otherwise.
          material: rgba(c.color, c.observed === c.count ? 0.85 : 0.45),
        },
      });
    const halo = theme === 'dark' ? Color.BLACK : Color.WHITE;
    for (const p of points) {
      const chosen = p.id === selectedPoint;
      entities.add({
        id: `p:${p.id}`,
        position: Cartesian3.fromDegrees(p.at[0], p.at[1]),
        point: {
          pixelSize: chosen ? 24 : SIZE[p.emphasis],
          color: rgba(p.color, p.emphasis === 'dim' ? 0.27 : ALPHA[p.evidence]),
          outlineColor: chosen
            ? selected
            : p.evidence === 'escenario'
              ? rgba(p.color, 1)
              : halo.withAlpha(p.emphasis === 'dim' ? 0.5 : 1),
          outlineWidth: chosen || p.evidence === 'escenario' ? 3 : 2,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          // Records stay visible and selectable behind hills and columns.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    entities.resumeEvents();
    instance.scene.requestRender();
  }, [points, columns, concessions, selectedPoint, selectedConcession, theme]);

  const homeKey = home.join(',');
  useEffect(() => {
    const camera = widget.current?.camera;
    if (camera) frameExtent(camera, home, 0.8);
    // `homeKey` stands for the four numbers of `home`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeKey]);

  useEffect(() => {
    const camera = widget.current?.camera;
    if (!focus || !camera) return;
    const extent: Extent | undefined =
      focus.extent ?? (focus.at ? [focus.at[0], focus.at[1], focus.at[0], focus.at[1]] : undefined);
    if (!extent) return;
    frameExtent(camera, extent, 0.8, camera.heading);
  }, [focus]);

  type Action = 'in' | 'out' | 'home' | '2d' | 'north';
  const act = (action: Action) => {
    const instance = widget.current;
    if (action === '2d') return onExit();
    if (!instance) return;
    const { camera } = instance;
    const height = camera.positionCartographic.height;
    if (action === 'in') camera.zoomIn(height * 0.4);
    else if (action === 'out') camera.zoomOut(height * 0.6);
    else if (action === 'home') frameExtent(camera, home, 0.8);
    else
      camera.flyTo({
        destination: camera.position,
        orientation: { heading: 0, pitch: camera.pitch, roll: 0 },
        duration: 0.5,
      });
    instance.scene.requestRender();
  };
  const controls: { label: string; icon: IconName; action: Action; pressed?: boolean }[] = [
    { label: 'Acercar', icon: 'plus', action: 'in' },
    { label: 'Alejar', icon: 'minus', action: 'out' },
    { label: homeLabel, icon: 'home', action: 'home' },
    { label: 'Vista 3D', icon: 'cube', action: '2d', pressed: true },
    { label: 'Norte arriba', icon: 'compass', action: 'north' },
  ];
  return (
    <div className={frame.wrap}>
      <div className={`${frame.frame} ${styles.frame}`}>
        <div
          ref={container}
          className={`${styles.canvas} ${styles.globe}`}
          role="region"
          aria-label={label}
          data-map-engine="cesium"
        />
        <div className={frame.controls}>
          {controls.map((c) => (
            <button
              key={c.label}
              type="button"
              className={frame.control}
              aria-label={c.label}
              title={c.label}
              aria-pressed={c.pressed}
              onClick={() => act(c.action)}
            >
              <Icon name={c.icon} />
            </button>
          ))}
        </div>
        <div ref={credits} className={styles.credits} />
      </div>
      <p id={hint} className={frame.hint}>
        Arrastre para mover el terreno y use la rueda o pellizque para acercar. Para inclinar y
        girar: Ctrl + arrastre, el botón central o dos dedos. Los registros también se eligen desde
        la evolución temporal.
      </p>
    </div>
  );
};

export default CesiumCanvas;
