import { ProjectCoordinatesResponse, type ProjectCoordinates } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { saveBlob } from '../../shared/api/download.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { BaseMap, type Extent, intersects, ringsPath, UNITS_PER_DEGREE } from './BaseMap.tsx';
import { SECHURA_EXTENT } from './sechura-base.ts';
import { checkConcessions, ringsExtent } from './geometry.ts';
import { MapFrame } from './MapFrame.tsx';
import { useMapView } from './useMapView.ts';
import { MapErrorBoundary } from './MapErrorBoundary.tsx';
import { GEOCATMIN_VIEWER, MiningCadastreLayer } from './MiningCadastreLayer.tsx';
import { Alert } from '../../shared/ui/Alert.tsx';
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
  const { valid: concessions, invalid } = checkConcessions(data.concessions);
  const [selection, setSelection] = useState(concessions[0]?.code ?? '');
  const [cadastre, setCadastre] = useState(true);
  const selected = concessions.find((c) => c.code === selection);
  // The map opens on the project: every drawable concession with a margin. Inside the Sechura
  // province the generalised districts and towns are drawn around it.
  const all = concessions.map((c) => ringsExtent(c.geometry.coordinates));
  const extent: Extent = all.length
    ? [
        Math.min(...all.map((e) => e[0])),
        Math.min(...all.map((e) => e[1])),
        Math.max(...all.map((e) => e[2])),
        Math.max(...all.map((e) => e[3])),
      ]
    : data.bbox;
  const onBase = intersects(extent, SECHURA_EXTENT);
  const homeSpan = Math.max(extent[2] - extent[0], extent[3] - extent[1], 0.01) * 1.3;
  const map = useMapView({
    home: [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2],
    homeSpan,
    // Down to about 500 m across.
    maxZoom: Math.max(homeSpan / 0.005, 1),
  });
  /** Frames one concession: centred, with a margin, within the zoom range. */
  const focus = (code: string) => {
    const concession = concessions.find((c) => c.code === code);
    if (!concession) return;
    const [x0, y0, x1, y1] = ringsExtent(concession.geometry.coordinates);
    const size = Math.max(x1 - x0, y1 - y0, 0.001) * 1.4;
    map.focus([(x0 + x1) / 2, (y0 + y1) / 2], homeSpan / size);
  };
  if (!concessions.length)
    return (
      <Card title={data.project_name}>
        <Alert tone="error">
          Ninguna concesión tiene una geometría válida para dibujar (
          {invalid.map((item) => `${item.name}: ${item.problem}`).join('; ')}). Revise el archivo de
          referencia antes de usar el mapa.
        </Alert>
      </Card>
    );
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
  const vertices = selected?.geometry.coordinates.reduce((n, ring) => n + ring.length, 0) ?? 0;
  return (
    <div className={styles.page}>
      <Card title={data.project_name} eyebrow="Concesiones del proyecto">
        {invalid.length ? (
          <Alert tone="error">
            No se dibujan {invalid.length} concesión(es) con geometría inválida:{' '}
            {invalid.map((item) => `${item.name} (${item.code}): ${item.problem}`).join('; ')}.
          </Alert>
        ) : null}
        <div className={styles.picker}>
          <label htmlFor="concession">Concesión</label>
          <select
            id="concession"
            value={selection}
            onChange={(event) => {
              setSelection(event.target.value);
              focus(event.target.value);
            }}
          >
            {concessions.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <MapErrorBoundary>
          <MapFrame
            map={map}
            homeLabel="Ver todas las concesiones"
            actions={[
              {
                label: 'Centrar concesión',
                icon: 'target',
                onClick: () => focus(selection),
                disabled: !selected,
              },
            ]}
          >
            {(hint) => (
              <BaseMap
                view={map.view}
                label="Geometría de referencia"
                title={`Concesiones referenciales en ${data.project_name}`}
                showBase={onBase}
                describedBy={hint}
              >
                {cadastre ? <MiningCadastreLayer view={map.view} /> : null}
                {concessions.map((c) => (
                  <path
                    key={c.code}
                    className={`${styles.concession} ${c.code === selection ? styles.concessionSelected : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Seleccionar ${c.name}`}
                    aria-pressed={c.code === selection}
                    onClick={() => setSelection(c.code)}
                    onDoubleClick={() => focus(c.code)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelection(c.code);
                      }
                    }}
                    d={ringsPath(c.geometry.coordinates)}
                    fill={c.code === selection ? '#e6b54a' : '#669bb5'}
                    stroke="#243b53"
                    fillRule="evenodd"
                    strokeWidth={(map.span / 400) * UNITS_PER_DEGREE}
                  />
                ))}
              </BaseMap>
            )}
          </MapFrame>
        </MapErrorBoundary>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={cadastre}
            onChange={(event) => setCadastre(event.target.checked)}
          />
          Catastro minero de INGEMMET (GEOCATMIN)
        </label>
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
          {cadastre ? (
            <li>
              <span className={`${styles.swatch} ${styles.swatchCadastre}`} aria-hidden="true" />
              Derechos mineros INGEMMET: azul titulado, verde en trámite, negro extinguido
            </li>
          ) : null}
        </ul>
        <p className={styles.note}>
          {onBase
            ? 'Coordenadas WGS 84, norte hacia arriba. Límites distritales generalizados (INEI) solo para orientación; no reemplazan cartografía oficial ni medición certificada.'
            : 'Plano referencial en longitud y latitud. Norte hacia arriba; sin base cartográfica ni medición certificada.'}
          {cadastre ? (
            <>
              {' '}
              Catastro minero de{' '}
              <a href={GEOCATMIN_VIEWER} target="_blank" rel="noreferrer">
                INGEMMET – GEOCATMIN
              </a>
              , referencial y de actualización diaria.
            </>
          ) : null}
        </p>
      </Card>
      {selected ? (
        <Card title={selected.name} eyebrow="Concesión seleccionada">
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
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => focus(selection)}>
              Ver en el mapa
            </Button>
            <Button variant="secondary" onClick={exportCoordinates}>
              Exportar coordenadas CSV
            </Button>
          </div>
          <details className={styles.vertices}>
            <summary>Vértices ({vertices})</summary>
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
          </details>
        </Card>
      ) : null}
      <Card title="Acerca del proyecto">
        <p>{data.initiative}</p>
        <p>{data.description}</p>
        <p className={styles.note}>{notice}</p>
      </Card>
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
