import { Fragment, Suspense, useId } from 'react';
import { AnswerView } from './answer-view.tsx';
import type { Turn } from './conversation.ts';
import styles from './Thread.module.css';

/** What a turn can do besides showing itself (chat-first-ui T6). */
type TurnActions = {
  onSearch: (text: string) => void;
  /** «Volver a preguntar»: the same question as a new turn. */
  onRetry?: ((question: string) => void) | undefined;
  /** The page's one status region, for what an action did («Copiado»). */
  onAnnounce?: ((message: string) => void) | undefined;
  /** An answer is pending: asking again waits for it. */
  busy: boolean;
};

/** The pending turn's progress text until the analyst names a step. */
const FIRST_STEP = 'Buscando registros…';

const Progress = ({ label, hidden = false }: { label: string; hidden?: boolean }) => (
  <p className={styles.step} aria-hidden={hidden || undefined}>
    <span className={styles.pulse} aria-hidden="true" />
    {label}
  </p>
);

const AssistantTurn = ({
  turn,
  onSearch,
  onRetry,
  onAnnounce,
  busy,
}: TurnActions & { turn: Turn }) => {
  const id = useId();
  return (
    <article className={styles.ai} aria-labelledby={id}>
      <p id={id} className={styles.who}>
        <span className={styles.ia}>IA</span> <span>Analista</span>
        <span className="visually-hidden">, respuesta a «{turn.question}»</span>
      </p>
      {turn.state === 'pending' ? (
        // Seen, not announced: the page's status region says when it starts and ends (L5). The
        // label is the stream's latest step (T21), drawn as text.
        <Progress label={turn.step ?? FIRST_STEP} />
      ) : turn.state === 'stopped' ? (
        // T7: the question went back to the composer; the page said «Respuesta detenida.».
        <p className={styles.stopped}>
          <span className={styles.halt} aria-hidden="true" />
          Detenido
        </p>
      ) : (
        // The answer view is its own chunk (T20). The thread asks through it before settling a turn,
        // so the fallback only shows when Inicio opens on earlier turns before it loaded; it keeps
        // the progress line's place and is hidden from the log, which reads the answer instead.
        <Suspense fallback={<Progress label={FIRST_STEP} hidden />}>
          <AnswerView
            turn={turn}
            onSearch={onSearch}
            onRetry={onRetry}
            onAnnounce={onAnnounce}
            busy={busy}
          />
        </Suspense>
      )}
    </article>
  );
};

/**
 * The conversation (odd/tasks/chat-first-ui.md T5, design/chat-first/02-atencion-primero.html):
 * a log of questions on the right and full-width answers, busy while one is pending. New turns
 * are read by the log once it is no longer busy; nothing inside it is a live region of its own.
 */
export const Thread = ({
  turns,
  pending,
  onSearch,
  onRetry,
  onAnnounce,
  anchor,
}: {
  turns: readonly Turn[];
  pending: boolean;
  onSearch: (text: string) => void;
  onRetry?: TurnActions['onRetry'];
  onAnnounce?: TurnActions['onAnnounce'];
  /** The id of each question, which the sidebar's «Conversaciones» brings into view (T19). */
  anchor?: (id: number) => string;
}) => (
  <div
    role="log"
    aria-label="Conversación con el analista"
    aria-busy={pending}
    className={styles.thread}
  >
    {turns.map((turn) => (
      <Fragment key={turn.id}>
        <article
          id={anchor?.(turn.id)}
          className={styles.user}
          aria-label="Tu pregunta"
          tabIndex={anchor ? -1 : undefined}
        >
          <p className={styles.bubble}>{turn.question}</p>
        </article>
        <AssistantTurn
          turn={turn}
          onSearch={onSearch}
          onRetry={onRetry}
          onAnnounce={onAnnounce}
          busy={pending}
        />
      </Fragment>
    ))}
  </div>
);
