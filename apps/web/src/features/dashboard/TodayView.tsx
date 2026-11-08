import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { DimensionBadge, LevelPill } from '../../shared/ui/Badges.tsx';
import { IrsaNoDataHint, IrsaStatus, hasNoEvidence } from './IrsaStatus.tsx';
import { dashboardQuery, irsaQuery, moduleRecordsQuery } from './api.ts';
import { criticalAlerts, recentEvents } from './model.ts';
import styles from './TodayView.module.css';

const TILES = [
  ['alertas_activas', 'Alertas activas', '/alertas'],
  ['demandas_abiertas', 'Demandas abiertas', '/demandas'],
  ['eventos', 'Eventos', '/eventos'],
  ['actores', 'Actores', '/actores'],
] as const;

const SHORTCUTS = [
  ['/eventos', 'Registrar evento'],
  ['/alertas', 'Revisar alertas'],
  ['/mapa', 'Ver territorio'],
  ['/fuentes', 'Consultar evidencia'],
] as const;

const today = () =>
  new Date().toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' });

const when = (date: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(date)
    ? new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('es-PE', {
        day: 'numeric',
        month: 'short',
      })
    : 'Sin fecha';

/**
 * Phone home (odd/tasks/mobile-first-redesign.md T9): what matters today in one screen —
 * the risk level, four counters, the alerts that need action, the latest events and the most
 * frequent tasks. The full analysis follows below it on the same page.
 */
export const TodayView = ({
  scope,
  renderLink,
}: {
  scope: string;
  renderLink: (to: string, children: ReactNode) => ReactNode;
}) => {
  const summary = useQuery(dashboardQuery(scope));
  const irsa = useQuery(irsaQuery(scope));
  const alerts = useQuery(moduleRecordsQuery('alertas', scope));
  const events = useQuery(moduleRecordsQuery('eventos', scope));
  const urgent = alerts.data ? criticalAlerts(alerts.data) : null;
  const latest = events.data ? recentEvents(events.data) : null;

  return (
    <div className={styles.today}>
      <section className={styles.lead} aria-labelledby="hoy-titulo">
        <p className={styles.date}>Hoy · {today()}</p>
        <h2 id="hoy-titulo">Resumen del proyecto</h2>
        {irsa.data ? (
          <>
            <p className={styles.risk}>
              {renderLink(
                '/irsa',
                <>
                  Riesgo IRSA{' '}
                  {hasNoEvidence(irsa.data) ? null : <strong>{irsa.data.irsa.toFixed(1)}</strong>}
                </>,
              )}{' '}
              <IrsaStatus scope={scope} irsa={irsa.data} />
            </p>
            <IrsaNoDataHint irsa={irsa.data} />
          </>
        ) : null}
      </section>

      <section aria-label="Indicadores del día">
        {summary.error ? (
          <p role="alert">No se pudo cargar el resumen.</p>
        ) : (
          <ul className={styles.tiles}>
            {TILES.map(([key, label, to]) => (
              <li
                key={key}
                className={styles.tile}
                data-alert={key === 'alertas_activas' && (summary.data?.[key] ?? 0) > 0}
              >
                {renderLink(
                  to,
                  <>
                    <span className={styles.value}>{summary.data ? summary.data[key] : '–'}</span>
                    <span className={styles.label}>{label}</span>
                  </>,
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.block} aria-labelledby="hoy-alertas">
        <div className={styles.blockHead}>
          <h2 id="hoy-alertas">Requiere atención</h2>
          {renderLink('/alertas', 'Ver todas')}
        </div>
        {alerts.error ? (
          <p role="alert">No se pudieron cargar las alertas.</p>
        ) : !urgent ? (
          <p role="status">Cargando…</p>
        ) : urgent.length === 0 ? (
          <p className={styles.empty}>Sin alertas abiertas de nivel amarillo o superior.</p>
        ) : (
          <ul className={styles.list}>
            {urgent.map((item) => (
              <li key={item.id}>
                <InternalLink href={objectHref('alertas', item.id)} className={styles.item}>
                  <span className={styles.slot}>
                    <LevelPill level={item.level} />
                  </span>
                  <span className={styles.itemText}>
                    <b>{item.title}</b>
                    <small>{when(item.date)}</small>
                  </span>
                </InternalLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.block} aria-labelledby="hoy-eventos">
        <div className={styles.blockHead}>
          <h2 id="hoy-eventos">Eventos recientes</h2>
          {renderLink('/eventos', 'Ver todos')}
        </div>
        {events.error ? (
          <p role="alert">No se pudieron cargar los eventos.</p>
        ) : !latest ? (
          <p role="status">Cargando…</p>
        ) : latest.length === 0 ? (
          <p className={styles.empty}>Aún no hay eventos en este proyecto.</p>
        ) : (
          <ul className={styles.list}>
            {latest.map((item) => (
              <li key={item.id}>
                <InternalLink href={objectHref('eventos', item.id)} className={styles.item}>
                  {item.dimension ? (
                    <DimensionBadge code={item.dimension} />
                  ) : (
                    <span className={styles.noDimension} aria-hidden="true" />
                  )}
                  <span className={styles.itemText}>
                    <b>{item.title}</b>
                    <small>{when(item.date)}</small>
                  </span>
                </InternalLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className={styles.block} aria-label="Accesos rápidos">
        <ul className={styles.shortcuts}>
          {SHORTCUTS.map(([to, label]) => (
            <li key={to}>{renderLink(to, label)}</li>
          ))}
        </ul>
      </nav>

      <h2 className={styles.divider}>Análisis del proyecto</h2>
    </div>
  );
};
