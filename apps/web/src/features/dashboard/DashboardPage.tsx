import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { COMPACT_QUERY, useMediaQuery } from '../../shared/lib/media.ts';
import { DIMENSIONS, DIMENSION_NAMES, LEVELS } from '../../shared/lib/text.ts';
import { DimensionBadge, LevelPill } from '../../shared/ui/Badges.tsx';
import { BarList } from '../../shared/ui/BarList.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { ColumnChart, DonutChart, RadarChart } from '../../shared/ui/charts/Charts.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { dashboardQuery, irsaQuery, modelStatusQuery, moduleRecordsQuery } from './api.ts';
import { alertsByLevel, eventsByDimension, eventsByMonth } from './model.ts';
import { TodayView } from './TodayView.tsx';
import styles from './DashboardPage.module.css';

/** Counter, label, module it comes from and the rule it applies (shown to the reader). */
const KPIS = [
  ['eventos', 'Eventos', '/eventos', 'Todos los eventos registrados.'],
  ['actores', 'Actores analíticos', '/actores', 'Todos los actores registrados.'],
  [
    'demandas_abiertas',
    'Demandas abiertas',
    '/demandas',
    'Demandas con estado distinto de «Cerrada».',
  ],
  [
    'alertas_activas',
    'Alertas activas',
    '/alertas',
    'Alertas que no están cerradas ni descartadas.',
  ],
  ['directorio', 'Directorio territorial', '/directorio', 'Contactos del directorio.'],
  ['priorizados', 'Actores priorizados', null, 'Matriz de priorización importada.'],
] as const;

/**
 * Executive dashboard (legacy `#dashboard`). Links are rendered by the app shell through
 * `renderLink`, so this feature does not depend on the router's route tree. Phones and
 * tablets open on the "Hoy" summary instead of the hero, counters and shortcuts, and keep the
 * analysis cards below it (docs/adr/0015).
 */
export const DashboardPage = ({
  scope,
  renderLink,
}: {
  scope: string;
  renderLink: (to: string, children: ReactNode) => ReactNode;
}) => {
  const summary = useQuery(dashboardQuery(scope));
  const irsa = useQuery(irsaQuery(scope));
  const status = useQuery(modelStatusQuery(scope));
  const alerts = useQuery(moduleRecordsQuery('alertas', scope));
  const events = useQuery(moduleRecordsQuery('eventos', scope));
  const compact = useMediaQuery(COMPACT_QUERY);

  return (
    <div className={styles.page}>
      {compact ? (
        <TodayView scope={scope} renderLink={renderLink} />
      ) : (
        <>
          <section className={styles.hero} aria-labelledby="hero-title">
            <p className={styles.kicker}>Monitoreo preventivo · G-A-D-N-E-I</p>
            <h2 id="hero-title">Riesgo socioambiental con evidencia y trazabilidad.</h2>
            <p>
              SIPGES integra información territorial, actores, demandas, narrativas, ambiente e
              institucionalidad para priorizar señales y orientar acciones preventivas.
            </p>
          </section>

          <Card eyebrow="Resumen operativo" title="Base Maestra del proyecto activo">
            <QueryState query={summary} label="el resumen">
              {(data) => {
                return (
                  <>
                    <dl className={styles.kpis}>
                      {KPIS.map(([key, label, to, rule]) => (
                        <div key={key} className={styles.kpi}>
                          <dt>{label}</dt>
                          <dd>{data[key]}</dd>
                          <dd className={styles.kpiRule}>
                            {rule} {to ? renderLink(to, 'Ver registros') : null}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p className={styles.kpiNote}>
                      Los indicadores cuentan los registros del proyecto activo y se actualizan al
                      guardar, importar o eliminar registros.
                    </p>
                  </>
                );
              }}
            </QueryState>
          </Card>
        </>
      )}

      <div className={styles.grid}>
        <Card eyebrow="Alertas por nivel" title="Alertas abiertas del proyecto">
          <QueryState query={alerts} label="las alertas">
            {(rows) => {
              const counts = alertsByLevel(rows);
              return (
                <DonutChart
                  caption="Alertas abiertas por nivel"
                  totalLabel="abiertas"
                  empty="Sin alertas abiertas."
                  data={LEVELS.map((level) => ({
                    key: level,
                    label: level,
                    value: counts[level],
                    tone: level,
                  }))}
                />
              );
            }}
          </QueryState>
        </Card>
        <Card eyebrow="Eventos por dimensión" title="G · A · D · N · E · I">
          <QueryState query={events} label="los eventos">
            {(rows) => {
              const counts = eventsByDimension(rows);
              return (
                <BarList
                  empty="Sin eventos."
                  bars={DIMENSIONS.map((code) => ({
                    key: code,
                    label: (
                      <span className={styles.dimLabel}>
                        <DimensionBadge code={code} /> {DIMENSION_NAMES[code]}
                      </span>
                    ),
                    value: counts[code],
                    tone: code,
                  }))}
                />
              );
            }}
          </QueryState>
        </Card>
      </div>

      <Card eyebrow="Tendencia" title="Eventos registrados por mes">
        <QueryState query={events} label="la tendencia de eventos">
          {(rows) => (
            <ColumnChart
              caption="Eventos registrados por mes"
              empty="Aún no hay eventos con fecha para mostrar una tendencia."
              data={eventsByMonth(rows)}
            />
          )}
        </QueryState>
      </Card>

      <div className={styles.grid}>
        <Card eyebrow="Índice de riesgo socioambiental" title="IRSA-SIPGES">
          <QueryState query={irsa} label="el IRSA">
            {(data) => (
              <>
                <p className={styles.irsa}>
                  <strong>{data.irsa.toFixed(1)}</strong> <LevelPill level={data.level} />
                </p>
                <div className={styles.radar}>
                  <RadarChart
                    caption="Puntaje IRSA por dimensión (0 a 100)"
                    data={DIMENSIONS.map((code) => ({
                      key: code,
                      label: code,
                      value: data.scores[code] ?? 0,
                    }))}
                  />
                </div>
                <ul className={styles.dims} aria-label="Puntaje por dimensión">
                  {DIMENSIONS.map((code) => (
                    <li key={code}>
                      <DimensionBadge code={code} />
                      <span>{(data.scores[code] ?? 0).toFixed(0)}</span>
                    </li>
                  ))}
                </ul>
                <p className={styles.note}>
                  Pesos y umbrales del IRSA son provisionales hasta su validación metodológica.
                </p>
              </>
            )}
          </QueryState>
        </Card>
        <Card eyebrow="Semáforo de alertas" title="Todas las alertas por nivel registrado">
          <QueryState query={summary} label="el semáforo">
            {(data) => (
              <BarList
                empty="Sin alertas registradas."
                bars={Object.entries(data.niveles).map(([level, value]) => ({
                  key: level,
                  label: level,
                  value,
                  tone: level,
                }))}
              />
            )}
          </QueryState>
        </Card>
      </div>

      <div className={styles.grid}>
        <Card
          eyebrow="Lectura prioritaria"
          title="Factores que requieren atención"
          action={renderLink('/irsa', 'Ver análisis')}
        >
          <QueryState query={irsa} label="los factores">
            {(data) =>
              data.drivers.length ? (
                <ol className={styles.drivers}>
                  {data.drivers.slice(0, 3).map((driver) => (
                    <li key={`${driver.dimension}-${driver.id}`}>
                      <DimensionBadge code={driver.dimension} />
                      <span>
                        <b>{driver.label}</b>
                        <small>{driver.dimension_label}</small>
                      </span>
                      <span className={styles.points}>{driver.points.toFixed(0)}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className={styles.note}>No hay factores calculables en este momento.</p>
              )
            }
          </QueryState>
        </Card>
        {compact ? null : (
          <Card eyebrow="Accesos rápidos" title="Actualizar el monitoreo">
            <ul className={styles.quick}>
              <li>{renderLink('/eventos', 'Registrar evento')}</li>
              <li>{renderLink('/alertas', 'Revisar alertas')}</li>
              <li>{renderLink('/fuentes', 'Consultar evidencia')}</li>
            </ul>
          </Card>
        )}
      </div>

      <Card eyebrow="Estado del modelo">
        <QueryState query={status} label="el estado del modelo">
          {(data) => (
            <div className={styles.status}>
              <b>{data.version}</b>
              <span>
                Validación de contenido: <b>{data.content_validation}</b> · Validación funcional:{' '}
                <b>{data.functional_validation ?? 'Pendiente'}</b>
              </span>
              <span className={styles.note}>{data.release_rule}</span>
            </div>
          )}
        </QueryState>
      </Card>
    </div>
  );
};
