import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { InternalLink } from '../../../shared/lib/navigation.tsx';
import { LevelPill } from '../../../shared/ui/Badges.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { dashboardQuery, irsaQuery, moduleRecordsQuery } from '../api.ts';
import { IrsaNoDataHint, IrsaStatus, hasNoEvidence } from '../IrsaStatus.tsx';
import { criticalAlerts, eventsThisWeek } from '../model.ts';
import styles from './InicioPage.module.css';

const SUGGESTIONS = [
  '¿Qué demandas siguen abiertas y quién las lidera?',
  'Resume lo ocurrido esta semana',
  '¿Qué compromisos vencen este mes?',
  '¿Qué alertas esperan aprobación?',
] as const;

const today = () =>
  new Date().toLocaleDateString('es-PE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

const Card = ({
  title,
  count,
  to,
  action,
  children,
}: {
  title: string;
  count?: number;
  to: string;
  action: string;
  children: ReactNode;
}) => {
  const id = useId();
  return (
    <section className={styles.card} aria-labelledby={id}>
      <h3 id={id}>
        {title}
        {count === undefined ? null : <span className={styles.count}>{count}</span>}
      </h3>
      {children}
      <InternalLink href={to} className={styles.more}>
        {action}
      </InternalLink>
    </section>
  );
};

/**
 * Inicio (odd/tasks/workspace-architecture.md T7a, design/workspace-architecture/01): a greeting,
 * the «Pregunta a SIPGES» composer and a calm briefing. Submitting a question does not call a
 * model: it opens the existing global search with the text (`onAsk`). Each briefing card renders
 * only when its source loaded, so a failing query hides the card instead of inventing numbers.
 */
export const InicioPage = ({
  scope,
  projectId,
  projectLabel,
  fullName,
  onAsk,
}: {
  scope: string;
  projectId: string;
  projectLabel: string;
  fullName: string;
  onAsk: (text: string) => void;
}) => {
  const [question, setQuestion] = useState('');
  const fieldId = useId();
  const suggestId = useId();
  const summary = useQuery(dashboardQuery(scope));
  const alerts = useQuery(moduleRecordsQuery('alertas', scope));
  const events = useQuery(moduleRecordsQuery('eventos', scope));
  const irsa = useQuery(irsaQuery(scope));

  const firstName = fullName.trim().split(/\s+/)[0] ?? '';
  const project = projectLabel || projectId;
  const ask = () => {
    const text = question.trim();
    if (text) onAsk(text);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    ask();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    ask();
  };

  const urgent = alerts.data ? criticalAlerts(alerts.data) : [];
  const week = events.data ? eventsThisWeek(events.data, new Date()) : null;
  const drivers = irsa.data?.drivers.slice(0, 3) ?? [];

  return (
    <div className={styles.home}>
      <section className={styles.hero} aria-labelledby={`${fieldId}-hola`}>
        <p className={styles.eyebrow}>
          {today()}
          {project ? ` · ${project}` : ''}
        </p>
        <h2 id={`${fieldId}-hola`} className={styles.title}>
          Hola{firstName ? `, ${firstName}` : ''}
        </h2>
        <form className={styles.ask} onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor={fieldId}>
            Pregunta a SIPGES
          </label>
          <textarea
            id={fieldId}
            rows={2}
            value={question}
            placeholder="Pregunta por eventos, actores, demandas o compromisos…"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className={styles.bar}>
            <span className={styles.scope}>
              <Icon name="layers" />
              Registros de {project || 'este proyecto'}
            </span>
            <span className={styles.hint}>
              <span>Enviar abre la búsqueda con tu pregunta</span>
            </span>
            <button type="submit" className={styles.send} aria-label="Enviar pregunta">
              <Icon name="arrowUp" />
            </button>
          </div>
        </form>
        <div className={styles.suggest}>
          <p id={suggestId} className={styles.suggestLabel}>
            Prueba con
          </p>
          <ul className={styles.chips} aria-labelledby={suggestId}>
            {SUGGESTIONS.map((text) => (
              <li key={text}>
                <button type="button" className={styles.chip} onClick={() => setQuestion(text)}>
                  {text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className={styles.brief} aria-labelledby={`${fieldId}-brief`}>
        <div className={styles.briefHead}>
          <h2 id={`${fieldId}-brief`}>Briefing de la semana</h2>
          <span className={styles.muted}>Últimos 7 días{project ? ` · ${project}` : ''}</span>
        </div>
        <div className={styles.grid}>
          {summary.data ? (
            <Card
              title="Alertas activas"
              count={summary.data.alertas_activas}
              to="/bandeja"
              action={`Abrir Bandeja (${summary.data.alertas_activas})`}
            >
              {urgent.length ? (
                <ul className={styles.list}>
                  {urgent.map((alert) => (
                    <li key={alert.id}>
                      <span className={styles.text}>
                        <b>{alert.title}</b>
                        <small>Alerta activa</small>
                      </span>
                      <LevelPill level={alert.level} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>
                  {summary.data.alertas_activas
                    ? 'Alertas activas por revisar.'
                    : 'Nada pendiente.'}
                </p>
              )}
            </Card>
          ) : null}
          {week ? (
            <Card
              title="Registros nuevos"
              count={week.total}
              to="/registros"
              action="Ver en Registros"
            >
              {week.items.length ? (
                <ul className={styles.list}>
                  {week.items.map((event) => (
                    <li key={event.id}>
                      <span className={styles.text}>
                        <b>{event.title}</b>
                        <small>Evento · {event.date.slice(0, 10)}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>Sin eventos fechados esta semana.</p>
              )}
            </Card>
          ) : null}
          {irsa.data ? (
            <Card title="Riesgo del territorio" to="/analisis" action="Abrir IRSA">
              <p className={styles.risk}>
                IRSA{' '}
                {hasNoEvidence(irsa.data) ? null : <strong>{irsa.data.irsa.toFixed(1)}</strong>}{' '}
                <IrsaStatus scope={scope} irsa={irsa.data} />
              </p>
              <IrsaNoDataHint irsa={irsa.data} />
              {drivers.length ? (
                <ul className={styles.list}>
                  {drivers.map((driver) => (
                    <li key={driver.id}>
                      <span className={styles.text}>
                        <b>{driver.label}</b>
                        <small>{driver.dimension_label}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <InternalLink href="/analisis?vista=riesgo" className={styles.more}>
                Riesgo de conflicto por localidad y actor (30 y 90 días)
              </InternalLink>
            </Card>
          ) : null}
        </div>
      </section>
    </div>
  );
};
