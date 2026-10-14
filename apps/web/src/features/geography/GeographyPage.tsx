import { ProjectCoordinatesResponse, type ProjectCoordinates } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { saveBlob } from '../../shared/api/download.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
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
  const viewWidth = (width * 1.1) / zoom;
  const viewHeight = (height * 1.1) / zoom;
  const viewBox = `${(minX + maxX - viewWidth) / 2 + pan.x} ${(-minY - maxY - viewHeight) / 2 + pan.y} ${viewWidth} ${viewHeight}`;
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
          <Button disabled={zoom >= 4} onClick={() => setZoom((z) => Math.min(z * 1.5, 4))}>
            Acercar
          </Button>
          <Button disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(z / 1.5, 1))}>
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
          <Button
            variant="secondary"
            onClick={() => setPan((p) => ({ ...p, x: p.x - width / 8 / zoom }))}
          >
            Oeste
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPan((p) => ({ ...p, x: p.x + width / 8 / zoom }))}
          >
            Este
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPan((p) => ({ ...p, y: p.y - height / 8 / zoom }))}
          >
            Norte
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPan((p) => ({ ...p, y: p.y + height / 8 / zoom }))}
          >
            Sur
          </Button>
          <Button variant="secondary" onClick={exportCoordinates}>
            Exportar coordenadas CSV
          </Button>
        </div>
        <svg
          className={styles.map}
          viewBox={viewBox}
          aria-label="Geometría de referencia"
          role="group"
        >
          <title>Concesiones referenciales en {data.project_name}</title>
          {data.concessions.map((c) => (
            <path
              key={c.code}
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
              d={c.geometry.coordinates
                .map(
                  (points) =>
                    points.map(([lon, lat], i) => `${i ? 'L' : 'M'} ${lon} ${-lat}`).join(' ') +
                    ' Z',
                )
                .join(' ')}
              fillRule="evenodd"
              fill={c.code === selection ? '#e6b54a' : '#669bb5'}
              stroke="#243b53"
              strokeWidth={width / 350}
            />
          ))}
        </svg>
        <p>
          Plano referencial en longitud y latitud. Norte hacia arriba; sin base cartográfica ni
          medición certificada.
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
