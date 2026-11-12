import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { territorialAlertsQuery } from '../../../shared/api/territorial-alerts.ts';
import { InternalLink } from '../../../shared/lib/navigation.tsx';
import { useScrollHints } from '../../../shared/lib/scroll-hints.ts';
import { LevelPill } from '../../../shared/ui/Badges.tsx';
import { EmptyState } from '../../../shared/ui/EmptyState.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { irsaQuery, moduleRecordsQuery } from '../api.ts';
import { IrsaStatus, hasNoEvidence } from '../IrsaStatus.tsx';
import { criticalAlerts, eventsThisWeek } from '../model.ts';
import { attentionItems } from './attention.ts';
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

/** Inicio puts actionable pending work first; the existing composer still opens global search. */
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
  const chips = useRef<HTMLUListElement>(null);
  useScrollHints(chips);
  const alerts = useQuery(moduleRecordsQuery('alertas', scope));
  const digital = useQuery(territorialAlertsQuery(scope));
  const events = useQuery(moduleRecordsQuery('eventos', scope));
  const irsa = useQuery(irsaQuery(scope));

  const firstName = fullName.trim().split(/\s+/)[0] ?? '';
  const project = projectLabel || projectId;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (text) onAsk(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    // The Enter that confirms an IME candidate must not send: Safari reports it as keyCode 229
    // with isComposing already false (modern-web-guidance ime-safe-enter-submit).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.currentTarget.form?.requestSubmit();
  };

  // The list (and its «nothing needs attention») waits for every source behind it; a failed one
  // shows its error with a retry that refetches only the sources that failed.
  const sources = [alerts, digital, irsa];
  const failed = sources.filter((query) => query.isError);
  const items =
    alerts.data && digital.data && irsa.data
      ? attentionItems({
          alerts: criticalAlerts(alerts.data),
          digital: digital.data,
          irsa: irsa.data,
        })
      : undefined;
  const attentionQuery = {
    isPending: sources.some((query) => query.isPending),
    error: failed[0]?.error ?? null,
    data: items,
    isFetching: failed.some((query) => query.isFetching),
    refetch: () => Promise.all(failed.map((query) => query.refetch())),
  };
  const week = events.data ? eventsThisWeek(events.data, new Date()) : null;
  const drivers = irsa.data?.drivers.slice(0, 3) ?? [];

  return (
    <div className={styles.home}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>
          {today()}
          {project ? ` · ${project}` : ''}
        </p>
        <h2 className={styles.title}>Hola{firstName ? `, ${firstName}` : ''}</h2>
      </header>

      <section className={styles.attention} aria-labelledby={`${fieldId}-att`}>
        <div className={styles.sectionHead}>
          <h2 id={`${fieldId}-att`}>Necesita tu atención</h2>
          {items?.length ? <span className={styles.muted}>{items.length}</span> : null}
          <InternalLink href="/bandeja" className={styles.headLink}>
            Abrir Bandeja
          </InternalLink>
        </div>
        <QueryState query={attentionQuery} label="lo que necesita tu atención">
          {(rows) =>
            rows.length ? (
              <ul className={styles.rows}>
                {rows.map((item) => (
                  <li key={item.key} className={styles.row}>
                    <span className={styles.rowText}>
                      <b>{item.title}</b>
                      <small>
                        {item.level ? <LevelPill level={item.level} /> : null}
                        {item.meta}
                      </small>
                    </span>
                    <InternalLink href={item.href} className={styles.rowAction}>
                      {item.action}
                    </InternalLink>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="check" title="Nada necesita tu atención ahora.">
                Las alertas y decisiones nuevas aparecerán aquí.
              </EmptyState>
            )
          }
        </QueryState>
      </section>

      <div className={styles.compose}>
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
          <ul ref={chips} className={styles.chips} aria-labelledby={suggestId}>
            <li className={styles.edge} aria-hidden="true" />
            {SUGGESTIONS.map((text) => (
              <li key={text}>
                <button type="button" className={styles.chip} onClick={() => setQuestion(text)}>
                  {text}
                </button>
              </li>
            ))}
            <li className={styles.edge} aria-hidden="true" />
          </ul>
        </div>
      </div>

      <section className={styles.brief} aria-labelledby={`${fieldId}-brief`}>
        <div className={styles.sectionHead}>
          <h2 id={`${fieldId}-brief`}>Esta semana</h2>
          <span className={styles.muted}>Últimos 7 días{project ? ` · ${project}` : ''}</span>
        </div>
        <div className={styles.grid}>
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
