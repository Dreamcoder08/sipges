import type { ModuleRecord } from '@mascli/contracts';
import { useId, useState } from 'react';
import { useLevelLabel } from '../../../shared/lib/project-settings.tsx';
import { DIMENSION_NAMES, type DimensionCode } from '../../../shared/lib/text.ts';
import { Alert } from '../../../shared/ui/Alert.tsx';
import { Button } from '../../../shared/ui/Button.tsx';
import { alertHeatmap, LEVEL_ORDER, MISSING_TERRITORY } from './alert-heatmap.ts';
import { LEVEL_LABEL } from './alert-overview.ts';
import styles from './Insights.module.css';

export const AlertHeatmap = ({
  rows,
  events = [],
  loading = false,
  failed = false,
  onRetry,
  onOpen,
}: {
  rows: readonly ModuleRecord[];
  events?: readonly ModuleRecord[];
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  onOpen: (id: string, from?: string) => void;
}) => {
  const id = useId();
  const levelName = useLevelLabel();
  const [selected, setSelected] = useState('');
  const data = alertHeatmap(rows, events);
  const cellKey = (dimension: string, territory: string) => JSON.stringify([dimension, territory]);
  const chosen = data.cells.find((cell) => cellKey(cell.dimension, cell.territory) === selected);
  const missing = data.cells
    .filter((cell) => cell.territory === MISSING_TERRITORY)
    .reduce((sum, cell) => sum + cell.rows.length, 0);
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Clasificación territorial</p>
          <h4 id={id}>Mapa de calor de relacionamiento comunitario</h4>
        </div>
        <span className={styles.count}>{data.active.length} activas</span>
      </div>
      <p className={styles.explanation}>
        Nivel de riesgo por dimensión MASCLI y comunidad: cada celda muestra el nivel máximo
        registrado y su número de alertas activas. Selecciónela para revisar los registros que la
        sustentan.
      </p>
      {loading ? (
        <p role="status">Consultando los territorios de los eventos vinculados…</p>
      ) : failed ? (
        <>
          <Alert tone="error">
            No se pudieron consultar los eventos vinculados. La clasificación territorial está
            pendiente.
          </Alert>
          <Button variant="secondary" onClick={onRetry}>
            Reintentar territorios
          </Button>
        </>
      ) : (
        <>
          {data.active.length ? (
            <>
              <div
                className={styles.scroller}
                role="region"
                aria-label="Matriz de calor por dimensión y territorio"
                tabIndex={0}
              >
                <table className={styles.matrix}>
                  <caption className="visually-hidden">
                    Nivel máximo documentado por dimensión MASCLI y territorio; las celdas vacías
                    indican sin datos.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Dimensión MASCLI</th>
                      {data.territories.map((t) => (
                        <th scope="col" key={t}>
                          {t}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.dimensions.map((dimension) => (
                      <tr key={dimension}>
                        <th scope="row">
                          <span
                            className={`${styles.dimension} ${styles[`dim${dimension}`] ?? ''}`}
                          >
                            {dimension}
                          </span>
                          {dimension === '?'
                            ? 'Sin dimensión clasificada'
                            : DIMENSION_NAMES[dimension as DimensionCode]}
                        </th>
                        {data.territories.map((territory) => {
                          const cell = data.cells.find(
                            (c) => c.dimension === dimension && c.territory === territory,
                          );
                          if (!cell) return <td key={territory}>Sin datos</td>;
                          const label = cell.level ? LEVEL_LABEL[cell.level] : 'Sin nivel';
                          return (
                            <td key={territory}>
                              <button
                                type="button"
                                data-return={`heat-${cellKey(dimension, territory)}`}
                                className={`${styles.heatCell} ${styles[cell.level ?? 'unknown']}`}
                                disabled={!cell.rows.length}
                                aria-pressed={chosen === cell}
                                aria-label={`${dimension} · ${territory}: ${cell.rows.length ? `${cell.rows.length} alerta(s), ${cell.level ? `${label} (${cell.level})` : 'sin nivel registrado'}` : 'sin datos'}`}
                                onClick={() => setSelected(cellKey(dimension, territory))}
                              >
                                <strong>{cell.rows.length ? label : 'Sin datos'}</strong>
                                {cell.rows.length ? (
                                  <span>{cell.rows.length} alerta(s)</span>
                                ) : null}
                                {cell.unknown ? <small>{cell.unknown} sin nivel</small> : null}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className={styles.legend} aria-label="Leyenda de niveles de riesgo">
                <li className={styles.legendTitle}>Nivel de riesgo:</li>
                {LEVEL_ORDER.map((level) => (
                  <li key={level}>
                    <i className={styles[level]} aria-hidden="true" />
                    {levelName(level, LEVEL_LABEL[level])}
                  </li>
                ))}
                <li>
                  <i className={styles.unknown} aria-hidden="true" />
                  Sin datos
                </li>
              </ul>
              <p className={styles.explanation}>
                Territorio tomado de la alerta o de una referencia exacta a su evento de origen.{' '}
                {missing
                  ? `${missing} alerta(s) requieren completar o verificar su territorio. `
                  : ''}
                Las alertas cerradas y descartadas siguen disponibles en «Alertas territoriales».
              </p>
              {chosen ? (
                <div className={styles.selection} aria-live="polite">
                  <h5>
                    {chosen.territory} · {chosen.dimension}
                  </h5>
                  <ul className={styles.recordList}>
                    {chosen.rows.map((row) => (
                      <li key={row._id}>
                        <div>
                          <strong>{String(row.Causa || row._id)}</strong>
                          <small>
                            {String(row.Nivel_Preliminar ?? row.Nivel ?? 'Sin nivel registrado')} ·{' '}
                            {String(row.Estado || 'Sin estado registrado')}
                          </small>
                        </div>
                        <Button
                          variant="secondary"
                          data-return={`insight-${row._id}`}
                          onClick={() =>
                            onOpen(row._id, `heat-${cellKey(chosen.dimension, chosen.territory)}`)
                          }
                        >
                          Ficha de alerta {row._id}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className={styles.explanation}>Seleccione una celda para abrir sus alertas.</p>
              )}
            </>
          ) : (
            <p role="status">No hay alertas activas para clasificar con los filtros actuales.</p>
          )}
        </>
      )}
    </section>
  );
};
