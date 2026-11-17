import { Fragment, useId } from 'react';
import { AnalystAnswer } from './AnalystAnswer.tsx';
import { AnswerActions } from './AnswerActions.tsx';
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

const AssistantTurn = ({
  turn,
  onSearch,
  onRetry,
  onAnnounce,
  busy,
}: TurnActions & { turn: Turn }) => {
  const id = useId();
  const retry = onRetry && !busy ? () => onRetry(turn.question) : undefined;
  return (
    <article className={styles.ai} aria-labelledby={id}>
      <p id={id} className={styles.who}>
        <span className={styles.ia}>IA</span> <span>Analista</span>
        <span className="visually-hidden">, respuesta a «{turn.question}»</span>
      </p>
      {turn.state === 'pending' ? (
        // Seen, not announced: the page's status region says when it starts and ends (L5).
        <p className={styles.step}>
          <span className={styles.pulse} aria-hidden="true" />
          Buscando registros…
        </p>
      ) : turn.state === 'stopped' ? (
        // T7: the question went back to the composer; the page said «Respuesta detenida.».
        <p className={styles.stopped}>
          <span className={styles.halt} aria-hidden="true" />
          Detenido
        </p>
      ) : (
        <>
          <AnalystAnswer
            question={turn.question}
            data={turn.state === 'answered' ? turn.answer : undefined}
            error={turn.state === 'failed' ? turn.error : undefined}
            onSearch={onSearch}
            onRetry={turn.state === 'failed' ? retry : undefined}
          />
          {turn.state === 'answered' ? (
            <AnswerActions
              answer={turn.answer.answer}
              sources={turn.answer.sources}
              onRetry={onRetry ? () => onRetry(turn.question) : undefined}
              onAnnounce={onAnnounce}
              busy={busy}
            />
          ) : null}
        </>
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
