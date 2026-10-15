import { useQueries, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FeatureContext } from '../../../shared/api/feature-context.ts';
import { InternalLink, objectHref } from '../../../shared/lib/navigation.tsx';
import { Alert } from '../../../shared/ui/Alert.tsx';
import { Button } from '../../../shared/ui/Button.tsx';
import { Card } from '../../../shared/ui/Card.tsx';
import { Field } from '../../../shared/ui/Field.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { recordsQuery } from '../api.ts';
import { moduleAttachmentsQuery } from '../evidence-api.ts';
import { MODULES } from '../modules.ts';
import {
  QUALITY_MODULES,
  qualityIssues,
  sourceInventory,
  type QualityData,
  type QualityIssue,
} from './model.ts';
import styles from '../Records.module.css';

const fieldLabel = (issue: QualityIssue) =>
  MODULES[issue.module].fields.find((field) => field.key === issue.field)?.label ?? issue.field;

const countLabel = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** A bounded review queue, never a scientific score or an automatic data repair. */
export const QualityPage = ({ scope }: FeatureContext) => {
  const queries = useQueries({
    queries: QUALITY_MODULES.map((module) => recordsQuery(module, scope, '')),
  });
  const files = useQuery(moduleAttachmentsQuery('fuentes', scope));
  const [filter, setFilter] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [page, setPage] = useState(0);
  const [sourcePage, setSourcePage] = useState(0);
  const failed = queries.filter((query) => query.isError);
  if (failed.length)
    return (
      <Card title="Calidad de datos">
        <Alert tone="error">
          No se pudo completar la revisión. No se muestran totales parciales como si fueran
          completos.
        </Alert>
        <Button onClick={() => void Promise.all(queries.map((query) => query.refetch()))}>
          Reintentar revisión
        </Button>
      </Card>
    );
  if (queries.some((query) => query.isPending))
    return <p role="status">Cargando los registros para revisión…</p>;
  const data: QualityData = {
    actores: queries[0]?.data ?? [],
    alertas: queries[1]?.data ?? [],
    eventos: queries[2]?.data ?? [],
    demandas: queries[3]?.data ?? [],
    acciones: queries[4]?.data ?? [],
    compromisos: queries[5]?.data ?? [],
    fuentes: queries[6]?.data ?? [],
  };
  const issues = qualityIssues(data);
  const recordCount = new Set(issues.map((issue) => `${issue.module}/${issue.id}`)).size;
  const reviewedCount = QUALITY_MODULES.filter((module) => module !== 'fuentes').reduce(
    (sum, module) => sum + data[module].length,
    0,
  );
  const visible = issues.filter(
    (issue) =>
      (!moduleFilter || issue.module === moduleFilter) &&
      `${issue.id} ${issue.title} ${issue.field} ${issue.reason}`
        .toLocaleLowerCase('es')
        .includes(filter.toLocaleLowerCase('es')),
  );
  const pages = Math.max(1, Math.ceil(visible.length / 50));
  const current = Math.min(page, pages - 1);
  const sourcePages = Math.max(1, Math.ceil(data.fuentes.length / 50));
  const currentSource = Math.min(sourcePage, sourcePages - 1);
  return (
    <div className={styles.page}>
      <Card
        title="Revisión de datos"
        action={
          <Button
            variant="secondary"
            onClick={() =>
              void Promise.all([...queries.map((query) => query.refetch()), files.refetch()])
            }
          >
            Actualizar revisión
          </Button>
        }
      >
        <p>
          {countLabel(issues.length, 'observación', 'observaciones')} en{' '}
          {countLabel(recordCount, 'registro por revisar', 'registros por revisar')}.{' '}
          {countLabel(reviewedCount, 'registro revisado', 'registros revisados')}.
        </p>
        <details>
          <summary>Cómo revisar los datos</summary>
          <p>
            Abre la ficha y consulta su evidencia antes de corregir. Se señalan campos ausentes o no
            clasificables y referencias de fuente no resolubles; estas también pueden corresponder a
            información restringida. La revisión no valida hechos ni deduce valores del texto.
          </p>
        </details>
        <div className={styles.search}>
          <Field
            label="Buscar en observaciones"
            type="search"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(0);
            }}
          />
          <div className={styles.field}>
            <label htmlFor="quality-module">Módulo de revisión</label>
            <select
              id="quality-module"
              value={moduleFilter}
              onChange={(event) => {
                setModuleFilter(event.target.value);
                setPage(0);
              }}
            >
              <option value="">Todos</option>
              {QUALITY_MODULES.filter((module) => module !== 'fuentes').map((module) => (
                <option value={module} key={module}>
                  {MODULES[module].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {visible.length ? (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className="visually-hidden">Observaciones verificables de datos</caption>
                <thead>
                  <tr>
                    <th scope="col">Módulo / registro</th>
                    <th scope="col">Campo</th>
                    <th scope="col">Motivo de revisión</th>
                    <th scope="col">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.slice(current * 50, (current + 1) * 50).map((issue) => (
                    <tr key={JSON.stringify([issue.module, issue.id, issue.field])}>
                      <td data-label="Registro">
                        <span>
                          {MODULES[issue.module].label} · {issue.id}
                          <br />
                          {issue.title}
                        </span>
                      </td>
                      <td data-label="Campo">{fieldLabel(issue)}</td>
                      <td data-label="Motivo">{issue.reason}</td>
                      <td data-label="Acción">
                        <InternalLink href={objectHref(issue.module, issue.id)}>
                          Revisar {issue.id}: {fieldLabel(issue)}
                        </InternalLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
              >
                Observaciones anteriores
              </Button>
              <p>
                Página {current + 1} de {pages} ·{' '}
                {countLabel(visible.length, 'observación', 'observaciones')}
              </p>
              <Button
                variant="secondary"
                disabled={current + 1 >= pages}
                onClick={() => setPage(current + 1)}
              >
                Más observaciones
              </Button>
            </div>
          </>
        ) : (
          <p>
            {issues.length
              ? 'No hay observaciones que coincidan con los filtros.'
              : 'No se detectaron los campos pendientes definidos en esta revisión. Esto no certifica la calidad ni la veracidad de los datos.'}
          </p>
        )}
      </Card>
      <Card title="Inventario de informes y fuentes">
        <p>
          {countLabel(data.fuentes.length, 'fuente accesible', 'fuentes accesibles')}. Los metadatos
          no garantizan que el original esté disponible; abre la ficha y su visor para comprobarlo.
        </p>
        <QueryState query={files} label="el inventario de archivos">
          {(attachments) => (
            <>
              {attachments.length >= 500 ? (
                <Alert tone="info">
                  La consulta de archivos está limitada a 500 metadatos. Una ausencia en este
                  inventario no demuestra que falte el archivo. La ficha consulta sus propios
                  adjuntos.
                </Alert>
              ) : null}
              {data.fuentes.length ? (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <caption className="visually-hidden">Fuentes y archivos asociados</caption>
                    <thead>
                      <tr>
                        <th scope="col">Fuente</th>
                        <th scope="col">Archivos registrados</th>
                        <th scope="col">Disponibilidad</th>
                        <th scope="col">Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sourceInventory(
                        data.fuentes.slice(currentSource * 50, (currentSource + 1) * 50),
                        attachments,
                        attachments.length >= 500,
                      ).map((source) => (
                        <tr key={source.id}>
                          <td data-label="Fuente">
                            <span>
                              {source.id}
                              <br />
                              {source.title}
                            </span>
                          </td>
                          <td data-label="Archivos">
                            <div>
                              {source.files.length
                                ? source.files.map((file) => (
                                    <p key={file.id}>
                                      {file.original_name} · {file.size_bytes} bytes
                                    </p>
                                  ))
                                : 'Sin metadatos en esta consulta'}
                            </div>
                          </td>
                          <td data-label="Disponibilidad">{source.status}</td>
                          <td data-label="Acción">
                            <InternalLink href={objectHref('fuentes', source.id)}>
                              Abrir fuente {source.id}
                            </InternalLink>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No hay fuentes registradas accesibles en el proyecto activo.</p>
              )}
              {sourcePages > 1 ? (
                <div className={styles.actions}>
                  <Button
                    disabled={currentSource === 0}
                    onClick={() => setSourcePage(currentSource - 1)}
                  >
                    Fuentes anteriores
                  </Button>
                  <p>
                    Página de fuentes {currentSource + 1} de {sourcePages}
                  </p>
                  <Button
                    disabled={currentSource + 1 >= sourcePages}
                    onClick={() => setSourcePage(currentSource + 1)}
                  >
                    Más fuentes
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </QueryState>
        {files.isError ? (
          <Button variant="secondary" onClick={() => void files.refetch()}>
            Reintentar inventario
          </Button>
        ) : null}
      </Card>
    </div>
  );
};
