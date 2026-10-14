import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';
import { saveBlob } from '../../shared/api/download.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import {
  DIMENSIONS,
  DIMENSION_NAMES,
  type DimensionCode,
  foldText,
  monthLabel,
} from '../../shared/lib/text.ts';
import { DimensionBadge, LevelPill } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { TimeHistogram } from '../../shared/ui/time/TimeHistogram.tsx';
import { BaseMap, svgX, svgY, UNITS_PER_DEGREE } from './BaseMap.tsx';
import { MapFrame } from './MapFrame.tsx';
import { useMapView } from './useMapView.ts';
import { COMPACT_QUERY, useMediaQuery } from '../../shared/lib/media.ts';
import { LOCALITIES } from './localities.ts';
import { SECHURA_EXTENT } from './sechura-base.ts';
import {
  LAYERS,
  type Layer,
  type MapPoint,
  type TerritorialRecord,
  filterPlace,
  inPeriod,
  mapPoints,
  monthlyCounts,
  monthsOf,
} from './territorial-model.ts';
import { TILE_ATTRIBUTION, TileLayer } from './TileLayer.tsx';
import styles from './TerritorialMap.module.css';

const Records = z.array(z.looseObject({ _id: z.string() }));
const CLOSED = new Set(['cerrada', 'cerrado', 'descartada', 'descartado']);

const useLayer = (slug: string, scope: string) =>
  useQuery({
    queryKey: ['records', scope, slug, 'all'],
    queryFn: ({ signal }) => requestJson(`/api/${slug}?limit=-1`, Records, { scope, signal }),
  });

const csvCell = (value: unknown) =>
  `"${String(value)
    .replace(/^[=+@-]/, "'$&")
    .replaceAll('"', '""')}"`;

/**
 * Territorial map: the project's events, demands and actors placed on an OpenStreetMap basemap
 * of the Sechura province, with filters, indicators, a detail panel and a timeline.
 */
export const TerritorialMapPage = ({ scope, projectId }: FeatureContext) => {
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
  const openAlerts =
    alerts.data?.filter(
      (a) =>
        (String(a['Proyecto_ID'] ?? '') || 'PRJ-SECHURA') === projectId &&
        !CLOSED.has(foldText(a['Estado'])),
    ).length ?? 0;
  return (
    <QueryState query={all} label="el mapa territorial">
      {(layers) => (
        <TerritorialWorkspace layers={layers} projectId={projectId} openAlerts={openAlerts} />
      )}
    </QueryState>
  );
};

/**
 * Places markers in map units. Records of the same locality share its coordinates, so they
 * are set around it on a small ring (in screen-sized units) instead of hiding each other.
 */
const spread = (points: readonly MapPoint[], unit: number) => {
  const groups = new Map<string, MapPoint[]>();
  for (const p of points) {
    const key = `${p.at[0]},${p.at[1]}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()].flatMap((group) =>
    group.map((point, i) => {
      const radius = group.length > 1 ? unit * (2.4 + group.length * 0.5) : 0;
      const angle = (2 * Math.PI * i) / group.length - Math.PI / 2;
      return {
        point,
        at: [
          svgX(point.at[0]) + radius * Math.cos(angle),
          svgY(point.at[1]) + radius * Math.sin(angle),
        ] as const,
      };
    }),
  );
};

const TerritorialWorkspace = ({
  layers,
  projectId,
  openAlerts,
}: {
  layers: Record<Layer, readonly TerritorialRecord[]>;
  projectId: string;
  openAlerts: number;
}) => {
  const id = useId();
  const [filters, setFilters] = useState({
    layer: '',
    dimension: '',
    locality: '',
    from: '',
    to: '',
  });
  const [selectedId, setSelectedId] = useState('');
  const compact = useMediaQuery(COMPACT_QUERY);
  const { points, unlocated } = useMemo(() => mapPoints(layers, projectId), [layers, projectId]);
  const placed = filterPlace(points, filters);
  const visible = placed.filter((p) => inPeriod(p, filters.from, filters.to));
  const months = monthsOf(points);
  const activity = monthlyCounts(placed);
  const selected = visible.find((p) => p.id === selectedId) ?? null;
  const localities = new Set(visible.map((p) => p.locality));
  const recent = [...visible].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  // Home view frames the visible points (or the whole province when there are none).
  const [minLon, minLat, maxLon, maxLat] = visible.length
    ? [
        Math.min(...visible.map((p) => p.at[0])),
        Math.min(...visible.map((p) => p.at[1])),
        Math.max(...visible.map((p) => p.at[0])),
        Math.max(...visible.map((p) => p.at[1])),
      ]
    : SECHURA_EXTENT;
  const home: readonly [number, number] = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
  const homeSpan = visible.length
    ? Math.max(maxLon - minLon, maxLat - minLat, 0.2) * 1.4
    : Math.max(maxLon - minLon, maxLat - minLat) * 1.05;
  const map = useMapView({ home, homeSpan, maxZoom: 32 });
  const view = map.view;
  const unit = (map.span / 100) * UNITS_PER_DEGREE;
  const markers = spread(visible, unit);
  const activeFilters = Object.values(filters).filter(Boolean).length;

  const set = (key: keyof typeof filters) => (value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setSelectedId('');
    if (key === 'locality') {
      const place = LOCALITIES.find((l) => l.name === value);
      map.focus(place ? place.at : null, 1);
    }
  };
  const focus = (point: MapPoint) => {
    setSelectedId(point.id);
    map.focus(point.at, Math.max(map.zoom, 4));
  };
  const exportCsv = () => {
    const rows = [
      ['Capa', 'ID', 'Fecha', 'Localidad', 'Territorio', 'Dimensión', 'Descripción', 'Lon', 'Lat'],
      ...visible.map((p) => [
        p.layer,
        p.id,
        p.date,
        p.locality,
        p.territory,
        p.dimension,
        p.title,
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

  return (
    <div className={styles.page}>
      <details className={styles.filters} key={String(compact)} open={!compact || undefined}>
        <summary>
          Filtros{activeFilters ? ` (${activeFilters} activos)` : ''} · {visible.length} registro(s)
          en el mapa
        </summary>
        <div className={styles.toolbar}>
          {select('layer', 'Capa', [['', 'Todas'], ...LAYERS.map((l): [string, string] => [l, l])])}
          {select('locality', 'Localidad', [
            ['', 'Toda la provincia'],
            ...LOCALITIES.map((l): [string, string] => [l.name, l.name]),
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
      </details>

      <div className={styles.layout}>
        <section className={styles.mapCard} aria-label="Mapa">
          <MapFrame map={map} homeLabel="Ver toda la provincia">
            {(hint) => (
              <BaseMap
                view={view}
                label="Mapa territorial de la provincia de Sechura"
                title="Registros georreferenciados en la provincia de Sechura"
                background={<TileLayer view={view} />}
                describedBy={hint}
              >
                {markers.map(({ point: p, at }) => {
                  const active = p.id === selectedId;
                  const r = unit * (active ? 3.4 : 2.6);
                  return (
                    <g
                      key={`${p.layer}-${p.id}`}
                      className={`${styles.marker} ${styles[p.dimension] ?? ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${p.layer}: ${p.title} (${p.locality})`}
                      aria-pressed={active}
                      onClick={() => setSelectedId(p.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(p.id);
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
          <ul className={styles.legendInline} aria-label="Dimensiones MASCLI">
            {DIMENSIONS.map((d) => (
              <li key={d}>
                <DimensionBadge code={d} /> {DIMENSION_NAMES[d]}
              </li>
            ))}
          </ul>
          <p className={styles.attribution}>
            Mapa base{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              {TILE_ATTRIBUTION}
            </a>
            . Ubicaciones aproximadas por localidad; los registros de una misma localidad se separan
            alrededor de ella.
            {unlocated ? ` ${unlocated} registro(s) sin localidad no se muestran.` : ''}
          </p>
        </section>

        <Card title="Detalle del punto seleccionado">
          {selected ? (
            <dl className={styles.detail}>
              <dt>Localidad</dt>
              <dd>{selected.locality}</dd>
              <dt>Capa</dt>
              <dd>{selected.layer}</dd>
              <dt>Dimensión</dt>
              <dd>
                <DimensionBadge code={selected.dimension} /> {DIMENSION_NAMES[selected.dimension]}
              </dd>
              <dt>Descripción</dt>
              <dd>{selected.title}</dd>
              {selected.actor ? (
                <>
                  <dt>Actor</dt>
                  <dd>{selected.actor}</dd>
                </>
              ) : null}
              <dt>Fecha</dt>
              <dd>{selected.date || 'Sin fecha'}</dd>
              <dt>Prioridad</dt>
              <dd>
                <LevelPill level={selected.level} />
              </dd>
              {selected.status ? (
                <>
                  <dt>Estado</dt>
                  <dd>{selected.status}</dd>
                </>
              ) : null}
              <dt>Código</dt>
              <dd>{selected.id}</dd>
            </dl>
          ) : (
            <p className={styles.note}>
              Seleccione un punto en el mapa o una fila de la tabla para ver su detalle.
            </p>
          )}
        </Card>
      </div>

      {activity.length > 1 ? (
        <Card title="Actividad por mes" eyebrow="Filtro temporal">
          <TimeHistogram
            series={activity}
            from={filters.from}
            to={filters.to}
            label="Registros georreferenciados por mes"
            onChange={(from, to) => {
              setFilters((f) => ({ ...f, from, to }));
              setSelectedId('');
            }}
          />
          <p className={styles.note}>
            Pulse un mes para ver solo ese periodo; con Mayús amplía el rango. Pulse de nuevo el mes
            seleccionado para ver todo el periodo.
          </p>
        </Card>
      ) : null}

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
          <dt>Actores georreferenciados</dt>
          <dd>{visible.filter((p) => p.layer === 'Actores').length}</dd>
        </div>
        <div className={openAlerts ? styles.alertKpi : undefined}>
          <dt>Alertas abiertas</dt>
          <dd>{openAlerts}</dd>
        </div>
      </dl>

      <div className={styles.bottom}>
        <Card title="Ubicaciones recientes">
          {recent.length ? (
            <div
              className={styles.tableWrap}
              tabIndex={0}
              role="region"
              aria-label="Ubicaciones recientes"
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Localidad</th>
                    <th scope="col">Dimensión</th>
                    <th scope="col">Descripción</th>
                    <th scope="col">
                      <span className="visually-hidden">Acción</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={`${p.layer}-${p.id}`} data-selected={p.id === selectedId}>
                      <td>{p.date || '—'}</td>
                      <td>{p.locality}</td>
                      <td>
                        <DimensionBadge code={p.dimension} />
                      </td>
                      <td>{p.title}</td>
                      <td>
                        <Button
                          variant="ghost"
                          aria-label={`Ubicar ${p.id} en el mapa`}
                          onClick={() => focus(p)}
                        >
                          Ubicar
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="Sin registros georreferenciados para estos filtros.">
              Indique la localidad (por ejemplo Sechura, Vice o Bayóvar) en el campo Territorio de
              eventos, demandas o actores.
            </EmptyState>
          )}
        </Card>
        <Card title="Línea de tiempo territorial">
          {recent.length ? (
            <ol className={styles.timeline}>
              {[...recent].reverse().map((p) => (
                <li key={`${p.layer}-${p.id}`}>
                  <span
                    className={`${styles.dot} ${styles[p.dimension] ?? ''}`}
                    aria-hidden="true"
                  />
                  <small>
                    {p.date || 'Sin fecha'} · {p.locality}
                  </small>
                  <span>
                    <DimensionBadge code={p.dimension as DimensionCode} /> {p.title}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.note}>Sin hitos para estos filtros.</p>
          )}
        </Card>
      </div>
    </div>
  );
};
