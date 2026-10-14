import { ProjectCoordinatesResponse, type ProjectCoordinates } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { saveBlob } from '../../shared/api/download.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { BaseMap, type Extent, intersects, ringsPath } from './BaseMap.tsx';
import { SECHURA_EXTENT } from './sechura-base.ts';
import styles from './Geography.module.css';

export const GeographyPage = ({ scope }: FeatureContext) => {
  const query = useQuery({
    queryKey: ['geography', scope],
    queryFn: ({ signal }) =>
      requestJson('/system/project-coordinates', ProjectCoordinatesResponse, { scope, signal }),
  });
  return (
    <QueryState query={query} label="geometría territorial">
      {({ data, notice }) =>
        data ? (
          <MapReference data={data} notice={notice} />
        ) : (
          <Card title="Referencia territorial">
            <p>{notice}</p>
          </Card>
        )
      }
    </QueryState>
  );
};

const csvCell = (value: unknown) =>
  `"${String(value)
    .replace(/^[=+@-]/, "'$&")
    .replaceAll('"', '""')}"`;
const MapReference = ({ data, notice }: { data: ProjectCoordinates; notice: string }) => {
  const [selection, setSelection] = useState(data.concessions[0]?.code ?? '');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const selected = data.concessions.find((c) => c.code === selection);
  const [minX, minY, maxX, maxY] = data.bbox;
  const width = Math.max(maxX - minX, 0.001);
  const height = Math.max(maxY - minY, 0.001);
  // Inside the Sechura province the map opens on the whole province around the project.
  const onBase = intersects(data.bbox, SECHURA_EXTENT);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const half = onBase
    ? Math.max(
        centerX - SECHURA_EXTENT[0],
        SECHURA_EXTENT[2] - centerX,
        centerY - SECHURA_EXTENT[1],
        SECHURA_EXTENT[3] - centerY,
      ) * 1.05
    : (Math.max(width, height) * 1.1) / 2;
  const maxZoom = onBase ? 16 : 4;
  const span = (half * 2) / zoom;
  const view: Extent = [
    centerX + pan.x - span / 2,
    centerY - pan.y - span / 2,
    centerX + pan.x + span / 2,
    centerY - pan.y + span / 2,
  ];
  const step = span / 6;
  const exportCoordinates = () => {
    const rows = [['Concesión', 'Código', 'Anillo', 'Vértice', 'Longitud', 'Latitud', 'CRS']];
    for (const c of data.concessions)
      for (const [ring, points] of c.geometry.coordinates.entries())
        for (const [index, [lon, lat]] of points.entries())
          rows.push([
            c.name,
            c.code,
            String(ring + 1),
            String(index + 1),
            String(lon),
            String(lat),
            data.crs.geometry,
          ]);
    saveBlob(
      new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
      'coordenadas-referenciales.csv',
    );
  };
  return (
    <div className={styles.page}>
      <Card title={data.project_name}>
        <p>{data.initiative}</p>
        <p>{data.description}</p>
        <p>{notice}</p>
        <label htmlFor="concession">Concesión</label>
        <select
          id="concession"
          value={selection}
          onChange={(event) => setSelection(event.target.value)}
        >
          {data.concessions.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
        <div className={styles.actions}>
          <Button
            disabled={zoom >= maxZoom}
            onClick={() => setZoom((z) => Math.min(z * 2, maxZoom))}
          >
            Acercar
          </Button>
          <Button disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(z / 2, 1))}>
            Alejar
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            Restablecer vista
          </Button>
          <Button variant="secondary" onClick={() => setPan((p) => ({ ...p, x: p.x - step }))}>
            Oeste
          </Button>
          <Button variant="secondary" onClick={() => setPan((p) => ({ ...p, x: p.x + step }))}>
            Este
          </Button>
          <Button variant="secondary" onClick={() => setPan((p) => ({ ...p, y: p.y - step }))}>
            Norte
          </Button>
          <Button variant="secondary" onClick={() => setPan((p) => ({ ...p, y: p.y + step }))}>
            Sur
          </Button>
          <Button variant="secondary" onClick={exportCoordinates}>
            Exportar coordenadas CSV
          </Button>
        </div>
        <BaseMap
          view={view}
          label="Geometría de referencia"
          title={`Concesiones referenciales en ${data.project_name}`}
          showBase={onBase}
        >
          {data.concessions.map((c) => (
            <path
              key={c.code}
              className={`${styles.concession} ${c.code === selection ? styles.concessionSelected : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`Seleccionar ${c.name}`}
              aria-pressed={c.code === selection}
              onClick={() => setSelection(c.code)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelection(c.code);
                }
              }}
              d={ringsPath(c.geometry.coordinates)}
              fillRule="evenodd"
              strokeWidth={span / 400}
            />
          ))}
        </BaseMap>
        <ul className={styles.legend}>
          <li>
            <span className={`${styles.swatch} ${styles.swatchConcession}`} aria-hidden="true" />
            Concesiones del proyecto
          </li>
          <li>
            <span className={`${styles.swatch} ${styles.swatchSelected}`} aria-hidden="true" />
            Concesión seleccionada
          </li>
          {onBase ? (
            <li>
              <span className={`${styles.swatch} ${styles.swatchLand}`} aria-hidden="true" />
              Distritos de la provincia de Sechura
            </li>
          ) : null}
        </ul>
        <p className={styles.note}>
          {onBase
            ? 'Coordenadas WGS 84, norte hacia arriba. Límites distritales generalizados (INEI) solo para orientación; no reemplazan cartografía oficial ni medición certificada.'
            : 'Plano referencial en longitud y latitud. Norte hacia arriba; sin base cartográfica ni medición certificada.'}
        </p>
      </Card>
      {selected ? (
        <Card title={selected.name}>
          <dl className={styles.facts}>
            <dt>Código</dt>
            <dd>{selected.code}</dd>
            <dt>Titular</dt>
            <dd>{selected.holder}</dd>
            <dt>Área nominal (ha)</dt>
            <dd>{selected.nominal_area_ha.toLocaleString('es-PE')}</dd>
            <dt>Área GIS referencial (ha)</dt>
            <dd>{selected.gis_area_ha.toLocaleString('es-PE')}</dd>
            <dt>Centroide referencial</dt>
            <dd>
              {selected.centroid.longitude}, {selected.centroid.latitude}
            </dd>
          </dl>
          <div
            className={styles.scroll}
            tabIndex={0}
            role="region"
            aria-label={`Vértices de ${selected.name}`}
          >
            <table>
              <caption>Vértices de {selected.name}</caption>
              <thead>
                <tr>
                  <th>Anillo</th>
                  <th>Vértice</th>
                  <th>Longitud</th>
                  <th>Latitud</th>
                </tr>
              </thead>
              <tbody>
                {selected.geometry.coordinates.flatMap((points, ring) =>
                  points.map(([lon, lat], index) => (
                    <tr key={`${ring}-${index}`}>
                      <td>{ring + 1}</td>
                      <td>{index + 1}</td>
                      <td>{lon}</td>
                      <td>{lat}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      <Card title="Origen y sistema de coordenadas">
        <dl className={styles.facts}>
          <dt>Organización</dt>
          <dd>{data.source.organization}</dd>
          <dt>Servicio</dt>
          <dd>{data.source.service}</dd>
          <dt>Conjunto de datos</dt>
          <dd>{data.source.dataset}</dd>
          <dt>Fecha de consulta</dt>
          <dd>{data.source.consulted_on}</dd>
          <dt>CRS geométrico</dt>
          <dd>{data.crs.geometry}</dd>
          <dt>Orden de ejes</dt>
          <dd>{data.crs.axis_order}</dd>
          <dt>Referencia proyectada</dt>
          <dd>{data.crs.projected_reference}</dd>
        </dl>
        <p>
          {data.nominal_area_source.label}: {data.nominal_area_source.scope}
        </p>
      </Card>
    </div>
  );
};
