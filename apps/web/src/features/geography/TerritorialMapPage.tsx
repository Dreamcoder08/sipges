import { GeographyCatalogue, GeographyResult } from '@sipges/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useId, useMemo, useRef, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { saveBlob } from '../../shared/api/download.ts';
import { moduleRecordsQuery } from '../../shared/api/module-records.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { COMPACT_QUERY, useMediaQuery } from '../../shared/lib/media.ts';
import { useProjectSettings } from '../../shared/lib/project-settings.tsx';
import {
  DIMENSIONS,
  DIMENSION_NAMES,
  type DimensionCode,
  foldText,
  monthLabel,
} from '../../shared/lib/text.ts';
import { DimensionBadge } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { BaseMap, type Extent, ringsPath, svgX, svgY, UNITS_PER_DEGREE } from './BaseMap.tsx';
import { BasemapCredit, BasemapPicker } from './BasemapPicker.tsx';
import { ConcessionCard, type Relation } from './ConcessionCard.tsx';
import {
  type Concession,
  concessionsOf,
  LEGEND,
  legendRgb,
  queryExtent,
  relationPolygon,
} from './concessions.ts';
import type { CanvasPoint, Focus } from './engine/types.ts';
import { RELIEF } from './engine/terrarium.ts';
import { supportsWebGl2 } from './engine/webgl.ts';
import { EVIDENCE, EVIDENCE_LABELS, type Evidence } from './evidence.ts';
import { EvidenceTag } from './EvidenceTag.tsx';
import { LOCALITIES } from './localities.ts';
import { MapErrorBoundary } from './MapErrorBoundary.tsx';
import { MapFrame } from './MapFrame.tsx';
import { MapSheet } from './MapSheet.tsx';
import { SIGNAL_MODULES } from './operations.ts';
import { OperationsPanel } from './OperationsPanel.tsx';
import { PointCard } from './PointCard.tsx';
import { projectArea } from './project-area.ts';
import {
  atCursor,
  filterPlace,
  inPeriod,
  LAYER_SLUGS,
  LAYERS,
  type Layer,
  type MapPoint,
  mapPoints,
  monthlyCounts,
  monthsOf,
  type TerritorialRecord,
} from './territorial-model.ts';
import { TerritorialTimeline } from './TerritorialTimeline.tsx';
import { type Basemap, TileLayer } from './TileLayer.tsx';
import { useMapView } from './useMapView.ts';
import styles from './TerritorialMap.module.css';

// The WebGL engine (MapLibre GL JS + deck.gl) is a separate chunk, loaded only for this map.
const GeoCanvas = lazy(() => import('./engine/GeoCanvas.tsx'));
const CesiumCanvas = lazy(() => import('./engine/CesiumCanvas.tsx'));

const CLOSED = new Set(['cerrada', 'cerrado', 'descartada', 'descartado']);
/** Widest view (degrees) for which the cadastre is requested; wider views ask to zoom in. */
export const MAX_CONCESSION_SPAN = 2.5;
const CADASTRE = { serviceId: 'SERV_CATASTRO_MINERO', layerId: 0 } as const;
/** Records the operational dossier starts from (ODD territorial-operations). */
const MAX_DOSSIER_SEEDS = 100;
const DOSSIER_MODULES = new Set<string>([...SIGNAL_MODULES, 'actores']);

/** Dimension colours of the design tokens (--dim-*), as RGB for the WebGL layers. */
const DIMENSION_RGB: Readonly<Record<DimensionCode, readonly [number, number, number]>> = {
  G: [43, 108, 176],
  A: [107, 70, 193],
  D: [183, 121, 31],
  N: [192, 86, 33],
  E: [47, 133, 90],
  I: [74, 85, 104],
};

/** Every page of a layer, in the cache entry Inicio and Registros also read. */
const useLayer = (slug: string, scope: string) => useQuery(moduleRecordsQuery(slug, scope));

const csvCell = (value: unknown) =>
  `"${String(value)
    .replace(/^[=+@-]/, "'$&")
    .replaceAll('"', '""')}"`;

const round = ([a, b, c, d]: Extent): Extent => {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return [r(a), r(b), r(c), r(d)];
};

/**
 * Territorial intelligence map (ODD geospatial-timeline): the project's events, demands and
 * actors with INGEMMET's mining concessions as selectable polygons, a contextual sheet and an
 * evolution timeline synchronised with the map.
 */
export const TerritorialMapPage = ({ scope }: FeatureContext) => {
  const events = useLayer('eventos', scope);
  const demands = useLayer('demandas', scope);
  const actors = useLayer('actores', scope);
  const alerts = useLayer('alertas', scope);
  const all = {
    isPending: events.isPending || demands.isPending || actors.isPending,
    error: events.error ?? demands.error ?? actors.error,
    data:
      events.data && demands.data && actors.data
        ? { Eventos: events.data, Demandas: demands.data, Actores: actors.data }
        : undefined,
  };
  // Every alert of the tenant counts: the tenant is the project (S13).
  const openAlerts = alerts.data?.filter((a) => !CLOSED.has(foldText(a['Estado']))).length ?? 0;
  return (
    <QueryState query={all} label="el mapa territorial">
      {(layers) => <TerritorialWorkspace layers={layers} openAlerts={openAlerts} scope={scope} />}
    </QueryState>
  );
};

/**
 * Places markers in map units for the SVG renderer. Records of the same locality share its
 * coordinates, so they are set around it on a small ring instead of hiding each other.
 */
const spread = <T extends { point: MapPoint }>(points: readonly T[], unit: number) => {
  const groups = new Map<string, T[]>();
  for (const p of points) {
    const key = `${p.point.at[0]},${p.point.at[1]}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()].flatMap((group) =>
    group.map((entry, i) => {
      const radius = group.length > 1 ? unit * (2.4 + group.length * 0.5) : 0;
      const angle = (2 * Math.PI * i) / group.length - Math.PI / 2;
      return {
        ...entry,
        at: [
          svgX(entry.point.at[0]) + radius * Math.cos(angle),
          svgY(entry.point.at[1]) + radius * Math.sin(angle),
        ] as const,
      };
    }),
  );
};

type Selection = { kind: 'point'; id: string } | { kind: 'concession'; concession: Concession };

const TerritorialWorkspace = ({
  layers,
  openAlerts,
  scope,
}: {
  layers: Record<Layer, readonly TerritorialRecord[]>;
  openAlerts: number;
  scope: string;
}) => {
  const id = useId();
  const area = projectArea(useProjectSettings()?.location);
  const [filters, setFilters] = useState({
    layer: '',
    dimension: '',
    locality: '',
    from: '',
    to: '',
  });
  const [evidence, setEvidence] = useState<readonly Evidence[]>(EVIDENCE);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [basemap, setBasemap] = useState<Basemap>('calles');
  const [engine, setEngine] = useState<'webgl' | 'svg'>(() => (supportsWebGl2() ? 'webgl' : 'svg'));
  const [showConcessions, setShowConcessions] = useState(true);
  const [relatedOnly, setRelatedOnly] = useState(false);
  const [influence, setInfluence] = useState(0);
  const [view3d, setView3d] = useState(false);
  /** Why the 3D view closed or is incomplete, shown under the map. */
  const [terrainNote, setTerrainNote] = useState('');
  const leave3d = (note: string) => {
    setView3d(false);
    setTerrainNote(note);
  };
  const terrainFailed = () =>
    leave3d('La vista 3D no pudo iniciarse en este navegador; se muestra el mapa en 2D.');
  const [cursor, setCursor] = useState('');
  const [playing, setPlaying] = useState(false);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [canvasView, setCanvasView] = useState<Extent | null>(null);
  const compact = useMediaQuery(COMPACT_QUERY);
  const mapSection = useRef<HTMLElement>(null);

  const { points, unlocated } = useMemo(
    () => mapPoints(layers, area.sechura),
    [layers, area.sechura],
  );
  const selectedConcession = selection?.kind === 'concession' ? selection.concession : null;

  const polygon = selectedConcession ? relationPolygon(selectedConcession) : null;
  const relationQuery = useQuery({
    queryKey: ['geocatmin-relation', scope, selectedConcession?.code, influence],
    enabled: Boolean(polygon),
    retry: false,
    staleTime: 300_000,
    queryFn: ({ signal }) =>
      requestJson('/system/geography/query', GeographyResult, {
        scope,
        signal,
        method: 'POST',
        body: {
          json: {
            ...CADASTRE,
            polygon,
            concessionCode: selectedConcession?.code,
            ...(influence ? { influenceMeters: influence } : {}),
          },
        },
      }),
  });
  const relatedKeys =
    relatedOnly && relationQuery.data
      ? new Set(relationQuery.data.related.map((r) => `${foldText(r.module)}:${r.id}`))
      : null;
  const related = (p: MapPoint) => !relatedKeys || relatedKeys.has(`${foldText(p.layer)}:${p.id}`);

  const placed = filterPlace(points, { ...filters, evidence }).filter(related);
  const visible = placed.filter((p) => inPeriod(p, filters.from, filters.to));
  const drawn = atCursor(visible, cursor);
  const months = monthsOf(points);
  const activity = monthlyCounts(placed);
  const selectedPoint =
    selection?.kind === 'point' ? (points.find((p) => p.id === selection.id) ?? null) : null;
  const localities = new Set(visible.map((p) => p.locality));
  // Sechura's towns for projects there; elsewhere the localities the records carry.
  const localityOptions = area.sechura
    ? LOCALITIES.map((l) => l.name)
    : [...new Set(points.map((p) => p.locality).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, 'es'),
      );
  const activeFilters =
    Object.values(filters).filter(Boolean).length + (evidence.length < EVIDENCE.length ? 1 : 0);

  // Home view frames the visible points (or the project's area when there are none).
  const [minLon, minLat, maxLon, maxLat] = visible.length
    ? [
        Math.min(...visible.map((p) => p.at[0])),
        Math.min(...visible.map((p) => p.at[1])),
        Math.max(...visible.map((p) => p.at[0])),
        Math.max(...visible.map((p) => p.at[1])),
      ]
    : area.extent;
  const home: readonly [number, number] = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const homeSpan = visible.length
    ? Math.max(maxLon - minLon, maxLat - minLat, 0.2) * 1.4
    : Math.max(maxLon - minLon, maxLat - minLat) * 1.05;
  const homeExtent: Extent = [
    home[0] - homeSpan / 2,
    home[1] - homeSpan / 2,
    home[0] + homeSpan / 2,
    home[1] + homeSpan / 2,
  ];
  const map = useMapView({ home, homeSpan, maxZoom: 32 });
  const unit = (map.span / 100) * UNITS_PER_DEGREE;

  // The cadastre follows the settled view of whichever renderer is drawing.
  const view = engine === 'webgl' ? canvasView : map.view;
  const span = view ? Math.max(view[2] - view[0], view[3] - view[1]) : Infinity;
  const bbox = view && span <= MAX_CONCESSION_SPAN ? round(queryExtent(view)) : null;
  // The official catalogue answers even when INGEMMET is down; the cadastre is only queried
  // once it confirms the layer, so an outage reads as a notice instead of failed requests.
  const catalogue = useQuery({
    queryKey: ['geocatmin-catalogue', scope],
    enabled: showConcessions,
    staleTime: 300_000,
    retry: false,
    queryFn: ({ signal }) =>
      requestJson('/system/geography/catalogue', GeographyCatalogue, { scope, signal }),
  });
  const cadastreReady = Boolean(
    catalogue.data?.layers.some(
      (l) =>
        l.serviceId === CADASTRE.serviceId &&
        l.id === CADASTRE.layerId &&
        l.capabilities.includes('Query'),
    ),
  );
  const cadastreDown = Boolean(catalogue.error) || (catalogue.isSuccess && !cadastreReady);
  const cadastre = useQuery({
    queryKey: ['geocatmin-concessions', scope, bbox?.join(',')],
    enabled: showConcessions && cadastreReady && Boolean(bbox),
    retry: false,
    staleTime: 300_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      requestJson('/system/geography/query', GeographyResult, {
        scope,
        signal,
        method: 'POST',
        body: { json: { ...CADASTRE, bbox } },
      }),
  });
  const concessions = useMemo(
    () => (cadastre.data ? concessionsOf(cadastre.data.features) : []),
    [cadastre.data],
  );
  // The selected concession stays drawn after the view moves away from the last query.
  const shownConcessions = !showConcessions
    ? []
    : selectedConcession && !concessions.some((c) => c.code === selectedConcession.code)
      ? [...concessions, selectedConcession]
      : concessions;

  const set = (key: keyof typeof filters) => (value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setSelection(null);
    setCursor('');
    setPlaying(false);
    if (key === 'locality') {
      const place = area.sechura
        ? LOCALITIES.find((l) => l.name === value)?.at
        : points.find((p) => p.locality === value)?.at;
      map.focus(place ?? null, 1);
      setFocus(place ? { at: place, zoom: 12 } : { extent: area.extent });
    }
  };
  const focusPoint = (point: MapPoint) => {
    setSelection({ kind: 'point', id: point.id });
    // On phones the list sits below the map: bring the map back above the sheet.
    if (compact) mapSection.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    map.focus(point.at, Math.max(map.zoom, 4));
    setFocus({ at: point.at, zoom: 13 });
  };
  const selectPoint = (pointId: string) => setSelection({ kind: 'point', id: pointId });
  const selectConcession = (code: string) => {
    const concession = shownConcessions.find((c) => c.code === code);
    if (!concession) return;
    setSelection({ kind: 'concession', concession });
    setRelatedOnly(false);
  };
  const closeSheet = () => {
    setSelection(null);
    setRelatedOnly(false);
  };
  const toggleEvidence = (state: Evidence) =>
    setEvidence((current) =>
      current.includes(state) ? current.filter((s) => s !== state) : [...current, state],
    );

  const exportCsv = () => {
    const rows = [
      [
        'Capa',
        'ID',
        'Fecha',
        'Localidad',
        'Territorio',
        'Dimensión',
        'Descripción',
        'Estado de la información',
        'Sustento',
        'Fuente',
        'Precisión',
        'Lon',
        'Lat',
      ],
      ...visible.map((p) => [
        p.layer,
        p.id,
        p.date,
        p.locality,
        p.territory,
        p.dimension,
        p.title,
        EVIDENCE_LABELS[p.evidence],
        p.evidenceBasis,
        p.source,
        p.precision === 'exacta' ? 'Coordenadas del registro' : 'Centro de la localidad',
        p.at[0].toFixed(5),
        p.at[1].toFixed(5),
      ]),
    ];
    saveBlob(
      new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
      'mapa-territorial.csv',
    );
  };

  const select = (key: keyof typeof filters, label: string, options: [string, string][]) => (
    <div className={styles.filter}>
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <select
        id={`${id}-${key}`}
        value={filters[key]}
        onChange={(event) => set(key)(event.target.value)}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );

  const canvasPoints: CanvasPoint[] = drawn.map(({ point, emphasis }) => ({
    id: point.id,
    at: point.at,
    color: DIMENSION_RGB[point.dimension],
    evidence: point.evidence,
    emphasis,
  }));
  const mapLabel = `Mapa territorial de ${area.place}`;

  const svgMap = (
    <MapFrame map={map} homeLabel={area.home}>
      {(hint) => (
        <BaseMap
          view={map.view}
          label={mapLabel}
          title={`Registros georreferenciados y concesiones en ${area.place}`}
          showBase={area.sechura}
          background={
            basemap === 'ninguno' ? undefined : <TileLayer view={map.view} basemap={basemap} />
          }
          imagery={basemap === 'satelite'}
          describedBy={hint}
        >
          {shownConcessions.map((c) => {
            const active = c.code === selectedConcession?.code;
            const rings =
              c.geometry.type === 'Polygon'
                ? c.geometry.coordinates
                : c.geometry.coordinates.flat();
            return (
              <path
                key={c.code}
                d={ringsPath(rings)}
                className={styles.concession}
                data-active={active}
                fillRule="evenodd"
                style={{ stroke: legendRgb(c.legend) }}
                strokeWidth={unit * (active ? 0.8 : 0.4)}
                role="button"
                tabIndex={0}
                aria-label={`Concesión ${c.name} (${c.code})`}
                aria-pressed={active}
                onClick={() => selectConcession(c.code)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectConcession(c.code);
                  }
                }}
              />
            );
          })}
          {spread(drawn, unit).map(({ point: p, emphasis, at }) => {
            const active = p.id === selectedPoint?.id;
            const r = unit * (active ? 3.4 : emphasis === 'current' ? 3.2 : 2.6);
            return (
              <g
                key={`${p.layer}-${p.id}`}
                className={`${styles.marker} ${styles[p.dimension] ?? ''} ${styles[`ev_${p.evidence}`] ?? ''}`}
                data-emphasis={emphasis}
                role="button"
                tabIndex={0}
                aria-label={`${p.layer}: ${p.title} (${p.locality})`}
                aria-pressed={active}
                onClick={() => selectPoint(p.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectPoint(p.id);
                  }
                }}
              >
                <circle cx={at[0]} cy={at[1]} r={r} strokeWidth={unit * 0.4} />
                <text x={at[0]} y={at[1] + r * 0.38} fontSize={r * 1.1} textAnchor="middle">
                  {p.dimension}
                </text>
              </g>
            );
          })}
        </BaseMap>
      )}
    </MapFrame>
  );

  const relation: Relation = {
    status: !polygon
      ? 'unsupported'
      : relationQuery.error
        ? 'error'
        : relationQuery.data
          ? 'ready'
          : 'pending',
    ...(relationQuery.data ? { data: relationQuery.data } : {}),
    retry: () => void relationQuery.refetch(),
  };
  const sheet = selectedConcession ? (
    <ConcessionCard
      concession={selectedConcession}
      source={cadastre.data?.source ?? relationQuery.data?.source ?? ''}
      relation={relation}
      points={points}
      relatedOnly={relatedOnly}
      onRelatedOnly={setRelatedOnly}
      influence={influence}
      onInfluence={setInfluence}
      onFocusPoint={focusPoint}
      onFrame={() => setFocus({ extent: selectedConcession.extent })}
      onClose={closeSheet}
    />
  ) : selectedPoint ? (
    <PointCard point={selectedPoint} onClose={closeSheet} />
  ) : null;
  // The operational dossier follows the selection: a concession's related records, one
  // record, or the most recent records visible on the map.
  const dossierScope: {
    seeds: { module: string; id: string }[];
    context: string;
    capped: boolean;
  } | null = selectedConcession
    ? relation.data
      ? {
          seeds: relation.data.related
            .map((r) => ({ module: foldText(r.module), id: r.id }))
            .filter((r) => DOSSIER_MODULES.has(r.module))
            .slice(0, MAX_DOSSIER_SEEDS),
          context: `Concesión ${selectedConcession.name}${influence ? ` y ${influence / 1000} km alrededor` : ''}`,
          capped: relation.data.related.length > MAX_DOSSIER_SEEDS,
        }
      : null
    : selectedPoint
      ? {
          seeds: [{ module: LAYER_SLUGS[selectedPoint.layer], id: selectedPoint.id }],
          context: `Registro ${selectedPoint.title}`,
          capped: false,
        }
      : {
          seeds: [...visible]
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, MAX_DOSSIER_SEEDS)
            .map((p) => ({ module: LAYER_SLUGS[p.layer], id: p.id })),
          context: 'Registros visibles en el mapa',
          capped: visible.length > MAX_DOSSIER_SEEDS,
        };

  const sheetTitle = selectedConcession
    ? `Ficha de la concesión ${selectedConcession.name}`
    : 'Ficha del registro';

  const cadastreStatus = !showConcessions
    ? null
    : catalogue.isPending
      ? 'Verificando el catastro minero de INGEMMET…'
      : cadastreDown
        ? 'El catastro minero de INGEMMET no está disponible ahora; los registros del proyecto siguen visibles.'
        : !bbox
          ? 'Acerque el mapa para consultar las concesiones del catastro minero.'
          : cadastre.isFetching
            ? 'Consultando el catastro minero de INGEMMET…'
            : cadastre.error
              ? null
              : `${concessions.length} concesión(es) de INGEMMET en esta vista${cadastre.data?.truncated ? '; se muestran las primeras 200, acerque el mapa para ver el resto' : ''}. Pulse una para ver su ficha.`;

  return (
    <div className={styles.page}>
      <details className={styles.filters} key={String(compact)} open={!compact || undefined}>
        <summary>
          Capas y filtros{activeFilters ? ` (${activeFilters} activos)` : ''} · {visible.length}{' '}
          registro(s) en el mapa
        </summary>
        <div className={styles.toolbar}>
          {select('layer', 'Capa', [['', 'Todas'], ...LAYERS.map((l): [string, string] => [l, l])])}
          {select('locality', 'Localidad', [
            ['', area.all],
            ...localityOptions.map((name): [string, string] => [name, name]),
          ])}
          {select('dimension', 'Dimensión', [
            ['', 'Todas'],
            ...DIMENSIONS.map((d): [string, string] => [d, `${d} · ${DIMENSION_NAMES[d]}`]),
          ])}
          {select('from', 'Desde', [
            ['', 'El inicio'],
            ...months.map((m): [string, string] => [m, monthLabel(m)]),
          ])}
          {select('to', 'Hasta', [
            ['', 'Hoy'],
            ...months.map((m): [string, string] => [m, monthLabel(m)]),
          ])}
          <Button variant="secondary" onClick={exportCsv} disabled={!visible.length}>
            Exportar CSV
          </Button>
        </div>
        <div className={styles.layerToggles}>
          <fieldset className={styles.checks}>
            <legend>Estado de la información</legend>
            {EVIDENCE.map((state) => (
              <label key={state}>
                <input
                  type="checkbox"
                  checked={evidence.includes(state)}
                  onChange={() => toggleEvidence(state)}
                />
                {EVIDENCE_LABELS[state]}
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.checks}>
            <legend>Capas oficiales</legend>
            <label>
              <input
                type="checkbox"
                checked={showConcessions}
                onChange={(event) => setShowConcessions(event.target.checked)}
              />
              Concesiones mineras (INGEMMET)
            </label>
          </fieldset>
        </div>
      </details>

      <div className={styles.layout}>
        <section ref={mapSection} className={styles.mapCard} aria-label="Mapa">
          {engine === 'webgl' && view3d ? (
            <MapErrorBoundary fallback={svgMap} onError={terrainFailed}>
              <Suspense fallback={<p role="status">Cargando el terreno 3D…</p>}>
                <CesiumCanvas
                  basemap={basemap}
                  home={homeExtent}
                  homeLabel={area.home}
                  showDistricts={area.sechura}
                  label={`${mapLabel} En 3D, con relieve.`}
                  points={canvasPoints}
                  concessions={shownConcessions}
                  selectedPoint={selectedPoint?.id ?? ''}
                  selectedConcession={selectedConcession?.code ?? ''}
                  focus={focus}
                  onExit={() => leave3d('')}
                  onSelectPoint={selectPoint}
                  onSelectConcession={selectConcession}
                  onReliefMissing={() =>
                    setTerrainNote(
                      'Parte del relieve no pudo descargarse; esa zona se muestra plana.',
                    )
                  }
                  onFailure={terrainFailed}
                />
              </Suspense>
            </MapErrorBoundary>
          ) : engine === 'webgl' ? (
            <MapErrorBoundary fallback={svgMap} onError={() => setEngine('svg')}>
              <Suspense fallback={<p role="status">Cargando el motor cartográfico…</p>}>
                <GeoCanvas
                  basemap={basemap}
                  home={homeExtent}
                  homeLabel={area.home}
                  showDistricts={area.sechura}
                  label={mapLabel}
                  points={canvasPoints}
                  concessions={shownConcessions}
                  selectedPoint={selectedPoint?.id ?? ''}
                  selectedConcession={selectedConcession?.code ?? ''}
                  focus={focus}
                  onView3d={() => {
                    setTerrainNote('');
                    setView3d(true);
                  }}
                  onSelectPoint={selectPoint}
                  onSelectConcession={selectConcession}
                  onView={setCanvasView}
                  onFailure={() => setEngine('svg')}
                />
              </Suspense>
            </MapErrorBoundary>
          ) : (
            svgMap
          )}
          <BasemapPicker value={basemap} onChange={setBasemap} />
          <ul className={styles.legendInline} aria-label="Dimensiones SIPGES">
            {DIMENSIONS.map((d) => (
              <li key={d}>
                <DimensionBadge code={d} /> {DIMENSION_NAMES[d]}
              </li>
            ))}
          </ul>
          <ul className={styles.legendInline} aria-label="Estado de la información">
            {EVIDENCE.map((state) => (
              <li key={state}>
                <EvidenceTag state={state} />
              </li>
            ))}
          </ul>
          {engine === 'webgl' && view3d ? (
            <p className={styles.note}>
              Vista 3D: relieve real de datos abiertos de elevación, exagerado 1,5 veces para
              leerlo. Cada columna reúne los registros documentados de una celda de unos 1,1 km y su
              altura es cuántos son (400 m por registro); es sólida si todos tienen coordenadas
              explícitas. Los escenarios no suman altura: nada aquí es una proyección.
              {basemap === 'ninguno'
                ? ' Sin mapa base, el terreno se colorea por altura: claro en la costa, marrón desde unos 600 m.'
                : ''}
            </p>
          ) : null}
          {terrainNote ? (
            <p className={styles.note} role="status">
              {terrainNote}
            </p>
          ) : null}
          {showConcessions ? (
            <>
              <ul className={styles.legendInline} aria-label="Catastro minero">
                {['TITULADO', 'TRAMITE', 'EXTINGUIDO', 'OTROS'].map((key) => (
                  <li key={key}>
                    <span
                      className={styles.swatch}
                      style={{ borderColor: legendRgb(key) }}
                      aria-hidden="true"
                    />
                    {LEGEND[key]?.label}
                  </li>
                ))}
              </ul>
              {cadastreStatus ? (
                <p className={styles.note} role="status">
                  {cadastreStatus}
                </p>
              ) : null}
              {cadastre.error && !cadastre.isFetching ? (
                <p role="alert" className={styles.note}>
                  No fue posible consultar el catastro de INGEMMET; los registros del proyecto
                  siguen disponibles.{' '}
                  <Button variant="ghost" onClick={() => void cadastre.refetch()}>
                    Reintentar
                  </Button>
                </p>
              ) : null}
            </>
          ) : null}
          <p className={styles.attribution}>
            <BasemapCredit basemap={basemap} />
            {engine === 'webgl' && view3d ? (
              <>
                {' '}
                Relieve:{' '}
                <a href={RELIEF.attribution.href} target="_blank" rel="noreferrer">
                  {RELIEF.attribution.text}
                </a>
                .
              </>
            ) : null}{' '}
            Concesiones: catastro minero GEOCATMIN de INGEMMET. Los registros sin coordenadas se
            ubican aproximadamente en su localidad.
            {unlocated ? ` ${unlocated} registro(s) sin localidad no se muestran.` : ''}
          </p>
        </section>

        {compact ? null : (
          <Card title="Ficha territorial">
            {sheet ?? (
              <p className={styles.note}>
                Seleccione una concesión o un registro en el mapa, o un registro de la evolución
                temporal, para ver sus fuentes, verificación y registros vinculados.
              </p>
            )}
          </Card>
        )}
      </div>

      {compact && sheet ? (
        <MapSheet title={sheetTitle} onClose={closeSheet}>
          {sheet}
        </MapSheet>
      ) : null}

      <Card title="Evolución temporal" eyebrow="Sincronizada con el mapa">
        <TerritorialTimeline
          series={activity}
          points={drawn.map((d) => d.point)}
          from={filters.from}
          to={filters.to}
          cursor={cursor}
          playing={playing}
          selectedId={selectedPoint?.id ?? ''}
          onPeriod={(from, to) => {
            setFilters((f) => ({ ...f, from, to }));
            setSelection((s) => (s?.kind === 'point' ? null : s));
            setCursor('');
            setPlaying(false);
          }}
          onCursor={setCursor}
          onPlaying={setPlaying}
          onSelect={focusPoint}
        />
      </Card>

      <Card title="Inteligencia operacional" eyebrow={dossierScope?.context ?? 'Concesión'}>
        {dossierScope ? (
          <OperationsPanel scope={scope} {...dossierScope} />
        ) : (
          <p className={styles.note} role="status">
            Esperando los registros vinculados a la concesión…
          </p>
        )}
      </Card>

      <dl className={styles.kpis}>
        <div>
          <dt>Localidades monitoreadas</dt>
          <dd>{localities.size}</dd>
        </div>
        <div>
          <dt>Eventos georreferenciados</dt>
          <dd>{visible.filter((p) => p.layer === 'Eventos').length}</dd>
        </div>
        <div>
          <dt>Registros observados</dt>
          <dd>{visible.filter((p) => p.evidence === 'observado').length}</dd>
        </div>
        <div className={openAlerts ? styles.alertKpi : undefined}>
          <dt>Alertas abiertas</dt>
          <dd>{openAlerts}</dd>
        </div>
      </dl>
    </div>
  );
};
