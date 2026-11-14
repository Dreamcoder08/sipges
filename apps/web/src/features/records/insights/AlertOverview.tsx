import type { ModuleRecord } from '@sipges/contracts';
import { limaToday } from '@sipges/kernel';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { InternalLink, objectHref, useInternalNavigate } from '../../../shared/lib/navigation.tsx';
import { useLevelLabel } from '../../../shared/lib/project-settings.tsx';
import { DIMENSION_NAMES, dimensionOf, type Level } from '../../../shared/lib/text.ts';
import { Button } from '../../../shared/ui/Button.tsx';
import { StackedColumnChart } from '../../../shared/ui/charts/Charts.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { recordsQuery } from '../api.ts';
import { AlertHeatmap } from './AlertHeatmap.tsx';
import { alertTerritory, LEVEL_ORDER, MISSING_TERRITORY, recordedLevel } from './alert-heatmap.ts';
import { alertDay, alertOverview, LEVEL_LABEL, type OverviewPeriod } from './alert-overview.ts';
import styles from './AlertOverview.module.css';

const PERIODS: readonly [OverviewPeriod, string][] = [
  [6, '6 meses'],
  [12, '12 meses'],
  ['todo', 'Todo'],
];

const MONTH = new Intl.DateTimeFormat('es-PE', { month: 'short', timeZone: 'UTC' });
const monthName = (month: string) => {
  const name = MONTH.format(new Date(`${month}-15T12:00:00Z`)).replace('.', '');
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

const LevelDot = ({ level }: { level: Level | null }) => {
  const levelName = useLevelLabel();
  return (
    <span className={styles.levelTag}>
      <i className={`${styles.dot} ${level ? styles[level] : styles.none}`} aria-hidden="true" />
      {level ? levelName(level, LEVEL_LABEL[level]) : 'Sin nivel'}
    </span>
  );
};

/**
 * The alert centre's first view: figures, community heat map, monthly evolution, priority
 * communities and latest alerts, all read from the active project's stored alerts.
 */
export const AlertOverview = ({ scope, onShowList }: { scope: string; onShowList: () => void }) => {
  const levelName = useLevelLabel();
  const [period, setPeriod] = useState<OverviewPeriod>(6);
  const [allCommunities, setAllCommunities] = useState(false);
  const navigate = useInternalNavigate();
  // Same key as the alert list, so switching tabs does not fetch twice.
  const alerts = useQuery(recordsQuery('alertas', scope, ''));
  const requiresEvents = Boolean(
    alerts.data?.some(
      (row) => row['Evento/Registro_Origen'] && alertTerritory(row) === MISSING_TERRITORY,
    ),
  );
  const events = useQuery({ ...recordsQuery('eventos', scope, ''), enabled: requiresEvents });
  const open = (id: string) => navigate(objectHref('alertas', id));

  return (
    <div className={styles.overview}>
      <div className={styles.toolbar} role="group" aria-label="Periodo de la vista general">
        <span className={styles.toolbarLabel} aria-hidden="true">
          Periodo:
        </span>
        {PERIODS.map(([value, label]) => (
          <Button
            key={String(value)}
            variant={period === value ? 'primary' : 'secondary'}
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      <QueryState query={alerts} label="las alertas">
        {(rows) => {
          const eventRows: readonly ModuleRecord[] = events.data ?? [];
          // The period ends in Lima's month, not the UTC one (a day ahead after 19:00).
          const data = alertOverview(rows, eventRows, period, limaToday());
          const previousLabel = period === 'todo' ? '' : `${period} meses anteriores`;
          const months = data.monthly.map((m) => m.month);
          const withYear = months.length > 12;
          const labels = months.map((m) =>
            withYear ? `${monthName(m)} ${m.slice(2, 4)}` : monthName(m),
          );
          const last = months.at(-1);
          const before = months.at(-2);
          const communities = allCommunities ? data.ranking : data.ranking.slice(0, 5);
          return (
            <>
              <dl className={styles.kpis}>
                <div>
                  <dt>Total de alertas</dt>
                  <dd className={styles.kpiValue}>{data.total}</dd>
                  <dd className={styles.kpiNote}>
                    {data.previous === null
                      ? `${data.active.length} activas`
                      : `${signed(data.total - data.previous)} frente a los ${previousLabel}`}
                  </dd>
                </div>
                <div className={styles.critical}>
                  <dt>Críticas (nivel rojo)</dt>
                  <dd className={styles.kpiValue}>{data.critical}</dd>
                  <dd className={styles.kpiNote}>{data.high} activas en medio-alto (naranja)</dd>
                </div>
                <div>
                  <dt>Comunidades sensibles</dt>
                  <dd className={styles.kpiValue}>{data.sensitive}</dd>
                  <dd className={styles.kpiNote}>
                    En medio-alto o crítico, de {data.communities} con alertas activas
                  </dd>
                </div>
                <div>
                  <dt>Tendencia mensual</dt>
                  <dd className={styles.kpiValue}>
                    {data.trend.change === null ? '—' : `${signed(data.trend.change)}%`}
                  </dd>
                  <dd className={styles.kpiNote}>
                    {last && before
                      ? `${data.trend.current} en ${monthName(last).toLowerCase()} frente a ${data.trend.before} en ${monthName(before).toLowerCase()}`
                      : 'Sin meses para comparar'}
                  </dd>
                </div>
              </dl>

              <div className={styles.grid}>
                <div className={styles.main}>
                  <AlertHeatmap
                    rows={data.inPeriod}
                    events={eventRows}
                    loading={requiresEvents && events.isPending}
                    failed={requiresEvents && events.isError}
                    onRetry={() => void events.refetch()}
                    onOpen={open}
                  />
                </div>
                <div className={styles.side}>
                  <section className={styles.panel} aria-labelledby="alert-evolution">
                    <h4 id="alert-evolution">Evolución de alertas</h4>
                    <StackedColumnChart
                      labels={labels}
                      caption="Alertas registradas por mes y nivel de riesgo"
                      empty="Aún no hay alertas con fecha en este periodo."
                      series={[
                        ...LEVEL_ORDER.map((level) => ({
                          key: level,
                          label: levelName(level, LEVEL_LABEL[level]),
                          tone: level,
                          values: data.monthly.map((m) => m.counts[level]),
                        })),
                        ...(data.monthly.some((m) => m.counts.sin)
                          ? [
                              {
                                key: 'sin',
                                label: 'Sin nivel',
                                tone: 'sinNivel',
                                values: data.monthly.map((m) => m.counts.sin),
                              },
                            ]
                          : []),
                      ]}
                    />
                    {data.undated ? (
                      <p className={styles.note}>
                        {data.undated} alerta(s) sin fecha no se grafican.
                      </p>
                    ) : null}
                  </section>
                  <section className={styles.panel} aria-labelledby="alert-communities">
                    <div className={styles.panelHeading}>
                      <h4 id="alert-communities">Comunidades prioritarias</h4>
                      {data.ranking.length > 5 ? (
                        <Button
                          variant="secondary"
                          aria-expanded={allCommunities}
                          onClick={() => setAllCommunities((all) => !all)}
                        >
                          {allCommunities ? 'Ver menos' : 'Ver todas'}
                        </Button>
                      ) : null}
                    </div>
                    {communities.length ? (
                      <ol className={styles.ranking}>
                        {communities.map((c, index) => (
                          <li key={c.territory}>
                            <span className={styles.rank}>{index + 1}</span>
                            <strong>{c.territory}</strong>
                            <span
                              className={`${styles.pill} ${c.level ? styles[`soft${c.level}`] : ''}`}
                            >
                              {c.level ? levelName(c.level, LEVEL_LABEL[c.level]) : 'Sin nivel'}
                            </span>
                            <span className={styles.count}>{c.count} alerta(s)</span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className={styles.note}>
                        Ninguna alerta activa del periodo tiene comunidad o territorio registrado.
                      </p>
                    )}
                    {data.missingTerritory ? (
                      <p className={styles.note}>
                        {data.missingTerritory} alerta(s) activa(s) sin comunidad registrada:
                        complete «Comunidad / territorio» en su ficha para ubicarlas.
                      </p>
                    ) : null}
                  </section>
                </div>
              </div>

              <section className={styles.panel} aria-labelledby="alert-recent">
                <div className={styles.panelHeading}>
                  <h4 id="alert-recent">Alertas recientes</h4>
                  <Button variant="secondary" onClick={onShowList}>
                    Ver todas las alertas
                  </Button>
                </div>
                {data.recent.length ? (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Fecha</th>
                          <th scope="col">Dimensión</th>
                          <th scope="col">Comunidad / territorio</th>
                          <th scope="col">Causa documentada</th>
                          <th scope="col">Nivel</th>
                          <th scope="col">Estado</th>
                          <th scope="col">Acción sugerida</th>
                          <th scope="col">
                            <span className="visually-hidden">Ficha</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recent.slice(0, 5).map((row) => {
                          const dimension = dimensionOf(row.Dimension);
                          const territory = alertTerritory(row, eventRows);
                          return (
                            <tr key={row._id}>
                              <td data-label="Fecha">{alertDay(row) ?? 'Sin fecha'}</td>
                              <td data-label="Dimensión">
                                {dimension
                                  ? `${dimension} - ${DIMENSION_NAMES[dimension]}`
                                  : 'Sin dimensión'}
                              </td>
                              <td data-label="Comunidad / territorio">
                                {territory === MISSING_TERRITORY ? 'Sin registrar' : territory}
                              </td>
                              <td data-label="Causa documentada" className={styles.cause}>
                                {String(row.Causa ?? '')}
                              </td>
                              <td data-label="Nivel">
                                <LevelDot level={recordedLevel(row)} />
                              </td>
                              <td data-label="Estado">{String(row.Estado || 'Sin estado')}</td>
                              <td data-label="Acción sugerida">
                                {String(row.Accion_Sugerida || '—')}
                              </td>
                              <td>
                                <InternalLink
                                  href={objectHref('alertas', row._id)}
                                  aria-label={`Ver alerta ${row._id}`}
                                >
                                  Ver
                                </InternalLink>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className={styles.note}>No hay alertas registradas en este periodo.</p>
                )}
              </section>
            </>
          );
        }}
      </QueryState>
    </div>
  );
};
