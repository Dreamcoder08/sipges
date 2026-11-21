import { useQuery } from '@tanstack/react-query';
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { territorialAlertsQuery } from '../../../shared/api/territorial-alerts.ts';
import { formatLongDay } from '../../../shared/lib/format.ts';
import { limaNoon, useLimaDay } from '../../../shared/lib/lima-day.ts';
import { useMediaQuery } from '../../../shared/lib/media.ts';
import { Composer, type ComposerMode } from '../../../shared/ui/Composer.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { scrollBehavior } from '../../../shared/lib/motion.ts';
import { useOnline } from '../../../shared/lib/online.ts';
import { useProjectSettings } from '../../../shared/lib/project-settings.tsx';
import { useScrollHints } from '../../../shared/lib/scroll-hints.ts';
import { IrsaPendingBadge } from '../../../shared/ui/IrsaPendingBadge.tsx';
import { irsaConfigQuery, irsaQuery, moduleRecordsQuery } from '../api.ts';
import { criticalAlerts, eventsThisWeek } from '../model.ts';
import { AttentionCards, type AttentionQuery, WeekLine } from './Attention.tsx';
import { AttentionPopover } from './AttentionPopover.tsx';
import { preloadAnswerView } from './answer-view.tsx';
import { analystStatusQuery } from './ask.ts';
import { attentionItems } from './attention.ts';
import { useAnalystThread, useSharedThread } from './thread-context.tsx';
import { Thread } from './Thread.tsx';
import { starterQuestions } from './starters.ts';
import styles from './InicioPage.module.css';

const today = () => formatLongDay();

/** The stylesheet's phone layout, where «Nueva conversación» joins the top bar (T15). */
const PHONE_QUERY = '(max-width: 40rem)';

/**
 * Inicio, direction 01 «Centro conversacional» (odd/tasks/chat-first-ui.md T19, L10). Empty, it is
 * one block centred in the column: greeting and status line, at most three cards of what needs
 * attention, the composer, one-click starter chips and «Esta semana» as one line of links. The
 * composer names what it does with its «Buscar | Preguntar» switch (T3): «Buscar» searches the
 * project's records (`onAsk`); «Preguntar», there only while external AI is on and the
 * installation has an analyst, asks the analyst, who answers with citations to the records it read
 * (odd/archive/agentic-analyst.md T1d). The status line states what the reader should know before
 * trusting the page: offline, AI, IRSA caveat. Once a question is asked the thread owns the column
 * with the composer docked below it, and the urgent items move to a «Necesita tu atención N» button
 * in the top bar, beside the destination's tabs (`tabs`). The view follows new turns only while the
 * person is at the bottom. The thread is the shell's (`thread-context.tsx`) when there is one.
 */
export const InicioPage = ({
  scope,
  projectId,
  projectLabel,
  fullName,
  onAsk,
  tabs,
}: {
  scope: string;
  projectId: string;
  projectLabel: string;
  fullName: string;
  onAsk: (text: string) => void;
  /** The destination's tabs («Inicio | Panel | Centro gerencial»), at the start of the top bar. */
  tabs?: ReactNode;
}) => {
  'use memo';
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
  const shared = useSharedThread();
  const conversation = thread.turns.length > 0;
  // On a phone the thread owns the screen (chat-first-ui T15): the greeting steps aside and
  // «Nueva conversación» waits as an icon beside the bell instead of on a row of its own.
  const phone = useMediaQuery(PHONE_QUERY);

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
  // In the commit, before the browser renders: Safari can lay out a longer turn and have the
  // observer report the end out of view before a passive effect runs, and the view would then stay
  // above the new answer with «Ir al final» shown.
  useLayoutEffect(() => {
    if (thread.turns.length) follow();
  }, [thread.turns]);

  const askAnalyst = (text: string) => {
    // Sending is the person's own move: the view goes to their question.
    following.current = true;
    // Answered, the question leaves the box (↑ brings it back); after an error it stays.
    void thread.ask(text).then((answered) => {
      if (answered) setQuestion((current) => (current.trim() === text ? '' : current));
    });
  };
  const onSubmit = (text: string) => {
    if (asking) askAnalyst(text);
    else onAsk(text);
  };
  // «Detener» and Esc abort the request (T7); the question goes back to the box for editing,
  // unless the person has already started writing another one there.
  const stop = () => {
    const stopped = thread.stop();
    if (stopped) setQuestion((current) => (current.trim() ? current : stopped));
  };
  const focusComposer = () => composer.current?.querySelector('textarea')?.focus();
  const newConversation = () => {
    thread.clear();
    // The button that was pressed is gone; the person continues in the box.
    focusComposer();
  };
  /** Where a question starts in the thread, for the sidebar's «Conversaciones». */
  const turnAnchor = (id: number) => `${fieldId}-turn-${id}`;
  const showTurn = (id: number) => {
    const turn = document.getElementById(turnAnchor(id));
    if (!turn) return;
    turn.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() });
    turn.focus({ preventScroll: true });
  };

  // The shell's «Nueva pregunta», Ctrl+Mayús+O and «Conversaciones» act here while Inicio is on
  // screen. Focus and scrolling wait a task: a closing drawer or a new screen's heading takes
  // focus in the same commit, and the composer or the question must have it last.
  const handle = useRef<{ clear: () => void; focus: () => void; showTurn: (id: number) => void }>(
    null,
  );
  useLayoutEffect(() => {
    handle.current = { clear: thread.clear, focus: focusComposer, showTurn };
  });
  const attach = shared?.attach;
  useEffect(() => {
    if (!attach) return;
    const timers = new Set<number>();
    const later = (step: () => void) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        step();
      }, 0);
      timers.add(timer);
    };
    const detach = attach({
      newConversation: () => {
        handle.current?.clear();
        later(() => handle.current?.focus());
      },
      showTurn: (id) => later(() => handle.current?.showTurn(id)),
    });
    return () => {
      detach();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [attach]);

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
  const attentionQuery: AttentionQuery = {
    isPending: sources.some((query) => query.isPending),
    error: failed[0]?.error ?? null,
    data: items,
    isFetching: failed.some((query) => query.isFetching),
    refetch: () => Promise.all(failed.map((query) => query.refetch())),
  };
  const limaDay = useLimaDay();
  const week = events.data ? eventsThisWeek(events.data, limaNoon(limaDay)) : null;
  // A chip sends at once, in the mode the switch shows (T4); the box shows what was sent.
  const starters = starterQuestions({ openAlerts });
  // A chip that the project's state adds goes first once the alerts load. The phone strip snaps,
  // and a snapped scroller keeps its snapped chip in place when one is added before it, which
  // would leave the new first chip out of view behind the start fade: the strip goes back to its
  // start, before paint, whenever the list changes.
  const starterKey = starters.join('\n');
  useLayoutEffect(() => {
    chips.current?.scrollTo?.({ left: 0, behavior: 'instant' });
  }, [starterKey]);
  const sendStarter = (text: string) => {
    setQuestion(text);
    onSubmit(text);
  };

  const weekLine = <WeekLine events={week?.total} irsa={irsa.data} />;
  const newChat = (
    <button
      type="button"
      className={phone ? styles.newChatIcon : styles.newChat}
      title="Nueva conversación · Ctrl+Mayús+O"
      aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
      onClick={newConversation}
    >
      <Icon name="plus" />
      {phone ? <span className="visually-hidden">Nueva conversación</span> : 'Nueva conversación'}
    </button>
  );

  return (
    <div className={styles.page}>
      {tabs || conversation ? (
        <div className={styles.bar}>
          {tabs}
          {conversation ? (
            <AttentionPopover query={attentionQuery}>{weekLine}</AttentionPopover>
          ) : null}
          {conversation && phone ? newChat : null}
        </div>
      ) : null}
      <div
        className={styles.home}
        data-thread={conversation || undefined}
        // Empty, the block sits centred in the column when there is room (a min-height that
        // leaves short screens in normal flow).
        data-centred={conversation ? undefined : ''}
      >
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

        {conversation ? null : (
          <div className={styles.attention}>
            <AttentionCards query={attentionQuery} />
          </div>
        )}
        {conversation ? (
          <div className={styles.conversation}>
            {phone ? null : <div className={styles.threadBar}>{newChat}</div>}
            <Thread
              turns={thread.turns}
              pending={thread.pending}
              onSearch={onAsk}
              // «Volver a preguntar» asks the analyst again, as a new turn (T6).
              onRetry={askAnalyst}
              onAnnounce={thread.announce}
              anchor={turnAnchor}
            />
          </div>
        ) : null}
        <div className={styles.compose}>
          <div
            ref={composer}
            className={styles.dock}
            // Someone who starts to write a question will read an answer: its chunk is fetched
            // now, so the first answer shows without waiting for code (T20).
            onFocus={asks ? preloadAnswerView : undefined}
            onKeyDown={asks ? preloadAnswerView : undefined}
          >
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
              onStop={stop}
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

        {conversation ? null : <div className={styles.week}>{weekLine}</div>}
        {/* The end of the page: in view means the person is at the bottom of the conversation. */}
        <span ref={end} className={styles.end} />
        {/* The one place that announces an answer starting and ending, once each (L5), a stop
            and what an answer's action did («Copiado», T6). */}
        <span role="status" className="visually-hidden">
          {thread.announcement}
        </span>
      </div>
    </div>
  );
};
