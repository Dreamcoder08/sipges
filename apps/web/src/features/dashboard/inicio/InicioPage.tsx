import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { territorialAlertsQuery } from '../../../shared/api/territorial-alerts.ts';
import { InternalLink } from '../../../shared/lib/navigation.tsx';
import { formatIndex, formatLongDay } from '../../../shared/lib/format.ts';
import { Composer, type ComposerMode } from '../../../shared/ui/Composer.tsx';
import { DateText } from '../../../shared/ui/DateText.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { scrollBehavior } from '../../../shared/lib/motion.ts';
import { useOnline } from '../../../shared/lib/online.ts';
import { useProjectSettings } from '../../../shared/lib/project-settings.tsx';
import { useScrollHints } from '../../../shared/lib/scroll-hints.ts';
import { LevelPill } from '../../../shared/ui/Badges.tsx';
import { EmptyState } from '../../../shared/ui/EmptyState.tsx';
import { IrsaPendingBadge } from '../../../shared/ui/IrsaPendingBadge.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { irsaConfigQuery, irsaQuery, moduleRecordsQuery } from '../api.ts';
import { IrsaStatus, hasNoEvidence } from '../IrsaStatus.tsx';
import { criticalAlerts, eventsThisWeek } from '../model.ts';
import { analystStatusQuery } from './ask.ts';
import { type AttentionItem, attentionItems } from './attention.ts';
import { useAnalystThread } from './conversation.ts';
import { Thread } from './Thread.tsx';
import { starterQuestions } from './starters.ts';
import styles from './InicioPage.module.css';

const today = () => formatLongDay();

/** The folded attention list in one line: how many, the first one and how many more (L6). */
const foldSummary = (items: readonly AttentionItem[] | undefined) =>
  !items
    ? ''
    : !items[0]
      ? ' · Nada ahora'
      : ` · ${items[0].title}${items.length > 1 ? ` y ${items.length - 1} más` : ''}`;

/** Ctrl+Mayús+O, or ⌘+Mayús+O on a Mac: a new conversation, as in the chat products (S2). */
const isNewConversationKey = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  event.shiftKey &&
  !event.altKey &&
  event.key.toLowerCase() === 'o' &&
  !event.isComposing &&
  event.keyCode !== 229;

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
 * Inicio (closure-roadmap T31, design/vanguard/01 as chosen in L11): what needs attention first,
 * then the composer, then the week. The composer names what it does with its «Buscar | Preguntar»
 * switch (chat-first-ui T3): «Buscar» searches the project's records (`onAsk`); «Preguntar», there
 * only while external AI is on and the installation has an analyst, asks the analyst, who answers
 * with citations to the records it read (odd/tasks/agentic-analyst.md T1d). A status line states what
 * the reader should know before trusting the page: offline, AI, IRSA caveat. Once a question is
 * asked the page holds the conversation (chat-first-ui T5, direction 02): the attention list and the
 * week fold into one line above the thread, the composer rests below it, and the view follows new
 * turns only while the person is at the bottom.
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
  const [choice, setChoice] = useState<ComposerMode>('preguntar');
  const fieldId = useId();
  const suggestId = useId();
  const chips = useRef<HTMLUListElement>(null);
  useScrollHints(chips);
  const composer = useRef<HTMLDivElement>(null);
  // On a phone the composer rests on the bottom of the screen in a strip the layout reserves; the
  // strip's height is the scroll padding that keeps a focused control clear of it (WCAG 2.2
  // SC 2.4.11, the stylesheet's phone layout).
  useEffect(() => {
    const strip = composer.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement.style;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      // As in AppShell: a root style write must not reflow the observed strip in the same frame.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        root.setProperty('--composer-height', `${strip.offsetHeight}px`);
      });
    });
    observer.observe(strip);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeProperty('--composer-height');
    };
  }, []);
  const online = useOnline();
  const aiOn = useProjectSettings()?.external_ai?.enabled ?? false;
  // The box asks only when the project switched external AI on and this installation has an
  // analyst; otherwise it stays a search box and says why (agentic-analyst S2, local QA T7).
  const status = useQuery(analystStatusQuery(scope));
  const asks = aiOn && status.data?.available === true;
  const noAnalyst = aiOn && status.data?.available === false;
  const aiOff = !aiOn && status.data?.available === true;
  // «Preguntar» is the default wherever it works; «Buscar» stays one click away.
  const asking = asks && choice === 'preguntar';
  const askUnavailable = asks
    ? undefined
    : !aiOn
      ? 'Preguntar no está disponible: la IA externa está desactivada en este proyecto.'
      : noAnalyst
        ? 'Preguntar no está disponible: el analista no está configurado en esta instalación.'
        : status.isPending
          ? 'Preguntar no está disponible todavía: comprobando el analista.'
          : 'Preguntar no está disponible: no se pudo comprobar el analista.';
  const alerts = useQuery(moduleRecordsQuery('alertas', scope));
  const digital = useQuery(territorialAlertsQuery(scope));
  const events = useQuery(moduleRecordsQuery('eventos', scope));
  const irsa = useQuery(irsaQuery(scope));
  const irsaConfig = useQuery(irsaConfigQuery(scope));

  const firstName = fullName.trim().split(/\s+/)[0] ?? '';
  const project = projectLabel || projectId;
  const thread = useAnalystThread(scope);
  const conversation = thread.turns.length > 0;
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);

  // Whether the end of the page is in view, from a sentinel after the composer (modern-web-guidance
  // scroll-position-aware-elements); without an observer the view always follows.
  const end = useRef<HTMLSpanElement>(null);
  const following = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  useEffect(() => {
    const sentinel = end.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const inView = entries.at(-1)?.isIntersecting ?? true;
        following.current = inView;
        setAtEnd(inView);
      },
      { rootMargin: '0px 0px 64px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);
  // Smooth unless the person prefers reduced motion (shared/lib/motion.ts).
  const toEnd = () => end.current?.scrollIntoView?.({ block: 'end', behavior: scrollBehavior() });
  const follow = useEffectEvent(() => {
    if (following.current) toEnd();
  });
  useEffect(() => {
    if (thread.turns.length) follow();
  }, [thread.turns]);

  const onSubmit = (text: string) => {
    if (!asking) {
      onAsk(text);
      return;
    }
    // Sending is the person's own move: the view goes to their question.
    following.current = true;
    // Answered, the question leaves the box (↑ brings it back); after an error it stays.
    void thread.ask(text).then((answered) => {
      if (answered) setQuestion((current) => (current.trim() === text ? '' : current));
    });
  };
  const newConversation = () => {
    thread.clear();
    setAttentionOpen(false);
    setWeekOpen(false);
    // The button that was pressed is gone; the person continues in the box.
    composer.current?.querySelector('textarea')?.focus();
  };
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!isNewConversationKey(event)) return;
    event.preventDefault();
    newConversation();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // The list (and its «nothing needs attention») waits for every source behind it; a failed one
  // shows its error with a retry that refetches only the sources that failed.
  const sources = [alerts, digital, irsa];
  const failed = sources.filter((query) => query.isError);
  const openAlerts = alerts.data ? criticalAlerts(alerts.data) : undefined;
  const items =
    openAlerts && digital.data && irsa.data
      ? attentionItems({
          alerts: openAlerts,
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
  // A chip sends at once, in the mode the switch shows (T4); the box shows what was sent.
  const starters = starterQuestions({ openAlerts });
  const sendStarter = (text: string) => {
    setQuestion(text);
    onSubmit(text);
  };

  const attentionSection = (
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
                      {item.level ? (
                        <span className={styles.level}>
                          <LevelPill level={item.level} />
                        </span>
                      ) : null}
                      {item.meta}
                    </small>
                  </span>
                  <InternalLink
                    href={item.href}
                    className={styles.rowAction}
                    {...(item.label ? { 'aria-label': item.label } : {})}
                  >
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
  );

  const weekSection = (
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
                      <small>
                        Evento · <DateText value={event.date} />
                      </small>
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
              IRSA actual{' '}
              {hasNoEvidence(irsa.data) ? null : <strong>{formatIndex(irsa.data.irsa)}</strong>}{' '}
              {/* The provisional caveat sits once, in the status line above. */}
              <IrsaStatus scope={scope} irsa={irsa.data} caveat={false} />
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
  );

  return (
    <div className={styles.home} data-thread={conversation || undefined}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>
          {today()}
          {project ? ` · ${project}` : ''}
        </p>
        <h2 className={styles.title}>Hola{firstName ? `, ${firstName}` : ''}</h2>
        <p className={styles.state}>
          <span role="status" className={styles.offline}>
            {online ? null : 'Sin conexión · lo que ves puede no estar al día'}
          </span>
          <span>{aiOn ? 'IA externa activada' : 'IA externa desactivada'}</span>
          <IrsaPendingBadge status={irsaConfig.data?.status} />
        </p>
      </header>

      {conversation ? (
        <div className={styles.fold}>
          <div className={styles.foldLine}>
            <button
              type="button"
              className={styles.foldButton}
              aria-expanded={attentionOpen}
              aria-controls={`${fieldId}-att-panel`}
              onClick={() => setAttentionOpen((open) => !open)}
            >
              <b>Necesita tu atención</b>{' '}
              {items?.length ? <span className={styles.badge}>{items.length}</span> : null}
              <span className={styles.first}>{foldSummary(items)}</span>
              <Icon name="chevronDown" className={styles.chev} />
            </button>
            <button
              type="button"
              className={styles.foldButton}
              aria-expanded={weekOpen}
              aria-controls={`${fieldId}-week-panel`}
              onClick={() => setWeekOpen((open) => !open)}
            >
              Esta semana
              <Icon name="chevronDown" className={styles.chev} />
            </button>
          </div>
          <div id={`${fieldId}-att-panel`} hidden={!attentionOpen}>
            {attentionSection}
          </div>
          <div id={`${fieldId}-week-panel`} hidden={!weekOpen}>
            {weekSection}
          </div>
        </div>
      ) : (
        attentionSection
      )}
      {conversation ? (
        <div className={styles.conversation}>
          <div className={styles.threadBar}>
            <button
              type="button"
              className={styles.newChat}
              title="Nueva conversación · Ctrl+Mayús+O"
              aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
              onClick={newConversation}
            >
              <Icon name="plus" />
              Nueva conversación
            </button>
          </div>
          <Thread turns={thread.turns} pending={thread.pending} onSearch={onAsk} />
        </div>
      ) : null}
      <div className={styles.compose}>
        <div ref={composer} className={styles.dock}>
          {conversation && !atEnd ? (
            <button type="button" className={styles.jump} onClick={toEnd}>
              <Icon name="arrowDown" />
              Ir al final
            </button>
          ) : null}
          <Composer
            mode={asking ? 'preguntar' : 'buscar'}
            onModeChange={setChoice}
            askUnavailable={askUnavailable}
            value={question}
            onValueChange={setQuestion}
            onSubmit={onSubmit}
            pending={thread.pending}
            // Until T7 passes an AbortSignal, stopping lets go of the answer: the request ends on
            // its own and its result is dropped, the question stays in the box.
            onStop={thread.stop}
            label={
              asking
                ? 'Preguntar, con citas'
                : `Buscar en registros de ${project || 'este proyecto'}`
            }
            placeholder={
              asking
                ? 'Pregunta por eventos, actores, demandas o compromisos…'
                : 'Palabras de eventos, actores, demandas o compromisos…'
            }
            hint={
              asking
                ? 'Enter pregunta · Mayús+Enter, nueva línea'
                : noAnalyst
                  ? 'El analista no está configurado en esta instalación: Enter busca.'
                  : aiOff
                    ? 'La IA externa está desactivada en este proyecto: Enter busca. Se activa en Configuración → Privacidad y datos.'
                    : 'Enter busca · Mayús+Enter, nueva línea'
            }
            sendLabel={asking ? 'Enviar pregunta' : 'Buscar en registros'}
          />
        </div>
        {/* Hidden, not removed, during a conversation: the strip keeps its scroll hints. */}
        <div className={styles.suggest} hidden={conversation}>
          <p id={suggestId} className={styles.suggestLabel}>
            Prueba con
          </p>
          <ul ref={chips} className={styles.chips} aria-labelledby={suggestId}>
            <li className={styles.edge} aria-hidden="true" />
            {starters.map((text) => (
              <li key={text}>
                <button type="button" className={styles.chip} onClick={() => sendStarter(text)}>
                  {text}
                </button>
              </li>
            ))}
            <li className={styles.edge} aria-hidden="true" />
          </ul>
        </div>
      </div>

      {conversation ? null : weekSection}
      {/* The end of the page: in view means the person is at the bottom of the conversation. */}
      <span ref={end} className={styles.end} />
      {/* The one place that announces an answer starting and ending, once each (L5). */}
      <span role="status" className="visually-hidden">
        {thread.announcement}
      </span>
    </div>
  );
};
