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
} from '../../shared/lib/text.ts';
import { DimensionBadge, LevelPill } from '../../shared/ui/Badges.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { BaseMap, type Extent } from './BaseMap.tsx';
import { LOCALITIES } from './localities.ts';
import { SECHURA_EXTENT } from './sechura-base.ts';
import {
  LAYERS,
  type Layer,
  type MapPoint,
  type TerritorialRecord,
  filterPoints,
  mapPoints,
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

const MONTH = new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (month: string) => {
  const label = MONTH.format(new Date(`${month}-01T12:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
};

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
  const [filters, setFilters] = useState({ layer: '', dimension: '', locality: '', month: '' });
  const [selectedId, setSelectedId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState<readonly [number, number] | null>(null);
  const { points, unlocated } = useMemo(() => mapPoints(layers, projectId), [layers, projectId]);
  const visible = filterPoints(points, filters);
  const months = monthsOf(points);
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
  const [cx, cy] = center ?? home;
  const span = homeSpan / zoom;
  const view: Extent = [cx - span / 2, cy - span / 2, cx + span / 2, cy + span / 2];
  const unit = span / 100;

  const set = (key: keyof typeof filters) => (value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setSelectedId('');
    if (key === 'locality') {
      const place = LOCALITIES.find((l) => l.name === value);
      setCenter(place ? place.at : null);
      setZoom(1);
    }
  };
  const focus = (point: MapPoint) => {
    setSelectedId(point.id);
    setCenter(point.at);
    setZoom((z) => Math.max(z, 2));
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
        {select('month', 'Periodo', [
          ['', 'Todo el periodo'],
          ...months.map((m): [string, string] => [m, monthLabel(m)]),
        ])}
        <Button variant="secondary" onClick={exportCsv} disabled={!visible.length}>
          Exportar CSV
        </Button>
      </div>

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

      <div className={styles.layout}>
        <Card title="Dimensiones MASCLI" eyebrow="Código de color">
          <ul className={styles.legend}>
            {DIMENSIONS.map((d) => (
              <li key={d}>
                <DimensionBadge code={d} /> {DIMENSION_NAMES[d]}
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            Cada punto es un registro con localidad identificada en su campo Territorio (o con
            coordenadas propias).
            {unlocated ? ` ${unlocated} registro(s) sin localidad no se muestran.` : ''}
          </p>
        </Card>

        <section className={styles.mapCard} aria-label="Mapa">
          <div className={styles.mapControls}>
            <Button
              variant="secondary"
              aria-label="Acercar"
              disabled={zoom >= 32}
              onClick={() => setZoom((z) => Math.min(z * 2, 32))}
            >
              +
            </Button>
            <Button
              variant="secondary"
              aria-label="Alejar"
              disabled={zoom <= 1}
              onClick={() => setZoom((z) => Math.max(z / 2, 1))}
            >
              −
            </Button>
            <Button
              variant="secondary"
              aria-label="Ver toda la provincia"
              onClick={() => {
                setZoom(1);
                setCenter(null);
              }}
            >
              ⌂
            </Button>
          </div>
          <BaseMap
            view={view}
            label="Mapa territorial de la provincia de Sechura"
            title="Registros georreferenciados en la provincia de Sechura"
            background={<TileLayer view={view} />}
          >
            {visible.map((p) => {
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
                  <circle cx={p.at[0]} cy={-p.at[1]} r={r} strokeWidth={unit * 0.4} />
                  <text x={p.at[0]} y={-p.at[1] + r * 0.38} fontSize={r * 1.1} textAnchor="middle">
                    {p.dimension}
                  </text>
                </g>
              );
            })}
          </BaseMap>
          <p className={styles.attribution}>
            Mapa base {TILE_ATTRIBUTION}. Ubicaciones aproximadas por localidad.
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
