import { GeographyCatalogue, GeographyResult, type GeographyPolygon } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { GEOCATMIN_VIEWER } from './MiningCadastreLayer.tsx';
export type OfficialSelection = { serviceId: string; layerId: number; opacity: number };
export const GeocatminControls = ({
  scope,
  selection,
  onChange,
  status,
  polygon,
  concessionCode,
}: {
  scope: string;
  selection: OfficialSelection[];
  onChange: (s: OfficialSelection[]) => void;
  status: Record<string, string>;
  polygon?: GeographyPolygon;
  concessionCode?: string;
}) => {
  const catalogue = useQuery({
    queryKey: ['geocatmin-catalogue', scope],
    queryFn: ({ signal }) =>
      requestJson('/system/geography/catalogue', GeographyCatalogue, { scope, signal }),
    staleTime: 300_000,
    retry: false,
  });
  const [consult, setConsult] = useState(false);
  const first = selection[0];
  const result = useQuery({
    queryKey: [
      'geocatmin-query',
      scope,
      first?.serviceId,
      first?.layerId,
      polygon,
      concessionCode,
      consult,
    ],
    enabled: consult && Boolean(first && polygon),
    retry: false,
    queryFn: ({ signal }) => {
      if (!first || !polygon) throw new Error('Seleccione capa y concesión');
      return requestJson('/system/geography/query', GeographyResult, {
        scope,
        signal,
        method: 'POST',
        body: {
          json: { serviceId: first.serviceId, layerId: first.layerId, polygon, concessionCode },
        },
      });
    },
  });
  return (
    <details>
      <summary>Capas oficiales GEOCATMIN y consulta territorial</summary>
      <p>
        INGEMMET · WGS84. Las escalas y capas se verifican en el servicio oficial; la fecha de
        comprobación no es la fecha de actualización de los datos.
      </p>
      {catalogue.isPending ? <p role="status">Verificando catálogo oficial…</p> : null}
      {catalogue.error || catalogue.data?.status === 'unavailable' ? (
        <p role="alert">
          No se pudo verificar el catálogo. El catastro existente puede fallar; las concesiones del
          proyecto siguen disponibles.{' '}
          <button type="button" onClick={() => void catalogue.refetch()}>
            Reintentar catálogo
          </button>
        </p>
      ) : null}
      <a href={GEOCATMIN_VIEWER} target="_blank" rel="noreferrer">
        Abrir visor oficial INGEMMET
      </a>
      {catalogue.data?.services.map((service) => (
        <p key={service.id}>
          {service.id}: {service.status === 'verified' ? 'verificado' : 'no disponible'} ·{' '}
          {service.checkedAt}
          {service.error ? ` · ${service.error}` : ''}
        </p>
      ))}
      {catalogue.data?.layers.map((layer) => {
        const key = `${layer.serviceId}:${layer.id}`,
          active = selection.find((s) => s.serviceId === layer.serviceId && s.layerId === layer.id);
        return (
          <fieldset key={key}>
            <legend>{layer.name}</legend>
            <label>
              <input
                type="checkbox"
                checked={Boolean(active)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [
                          ...selection,
                          { serviceId: layer.serviceId, layerId: layer.id, opacity: 0.7 },
                        ]
                      : selection.filter((s) => s !== active),
                  )
                }
              />
              Mostrar {layer.name}
            </label>
            <label>
              Opacidad {layer.name}
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={active?.opacity ?? 0.7}
                disabled={!active}
                onChange={(e) =>
                  onChange(
                    selection.map((s) =>
                      s === active ? { ...s, opacity: Number(e.target.value) } : s,
                    ),
                  )
                }
              />
            </label>
            <p>
              {layer.attribution} · Escalas mín./máx.:{' '}
              {layer.minScale === null ? 'desconocida' : layer.minScale || 'sin límite publicado'} /{' '}
              {layer.maxScale === null ? 'desconocida' : layer.maxScale || 'sin límite publicado'} ·{' '}
              {layer.capabilities} ·{' '}
              <a href={`${layer.metadataUrl}?f=pjson`} target="_blank" rel="noreferrer">
                Metadatos oficiales
              </a>
            </p>
            {active ? (
              <p role={status[key] === 'error' ? 'alert' : 'status'}>
                {status[key] === 'loaded'
                  ? 'Imagen cargada'
                  : status[key] === 'error'
                    ? 'No se pudo cargar esta capa oficial'
                    : 'Cargando imagen oficial…'}
              </p>
            ) : null}
          </fieldset>
        );
      })}
      {polygon ? (
        <>
          <button
            type="button"
            disabled={!first || result.isFetching}
            onClick={() => {
              if (consult) void result.refetch();
              else setConsult(true);
            }}
          >
            Consultar intersecciones de la concesión
          </button>
          <p>
            Consulta la primera capa seleccionada. Relaciones MASCLI: coordenadas/GeoJSON WGS84
            explícitos o código de concesión con fuente documentada; no se deducen de nombres.
          </p>
        </>
      ) : null}
      {result.isFetching ? <p role="status">Consultando geometría oficial…</p> : null}
      {result.error ? (
        <p role="alert">La consulta oficial no está disponible. Reintente o consulte INGEMMET.</p>
      ) : null}
      {result.data ? (
        <div>
          <p>
            {result.data.features.length} elemento(s) oficial(es).{' '}
            {result.data.truncated ? 'Resultado truncado: reduzca el área.' : ''}
          </p>
          {result.data.features.map((f, i) => (
            <details key={i}>
              <summary>Atributos oficiales {i + 1}</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(f.attributes, null, 2)}
              </pre>
            </details>
          ))}
          <p>Registros MASCLI relacionados ({result.data.related.length})</p>
          <ul>
            {result.data.related.map((r) => (
              <li key={`${r.module}:${r.id}`}>
                {r.module} · {r.id} ·{' '}
                {r.relationship === 'geometry'
                  ? 'Intersección geométrica'
                  : 'Referencia explícita documentada'}{' '}
                · {r.evidence}
              </li>
            ))}
          </ul>
          <p>
            Sin localización válida ({result.data.unlocated.length}); excluidos de la intersección
            geométrica
          </p>
          <ul>
            {result.data.unlocated.map((r) => (
              <li key={`${r.module}:${r.id}`}>
                {r.module} · {r.id}: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  );
};
