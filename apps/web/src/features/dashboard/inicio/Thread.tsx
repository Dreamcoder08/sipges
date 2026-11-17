import { Fragment, useId } from 'react';
import { AnalystAnswer } from './AnalystAnswer.tsx';
import type { Turn } from './conversation.ts';
import styles from './Thread.module.css';

const AssistantTurn = ({ turn, onSearch }: { turn: Turn; onSearch: (text: string) => void }) => {
  const id = useId();
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
      ) : (
        <AnalystAnswer
          question={turn.question}
          data={turn.state === 'answered' ? turn.answer : undefined}
          error={turn.state === 'failed' ? turn.error : undefined}
          onSearch={onSearch}
        />
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
}: {
  turns: readonly Turn[];
  pending: boolean;
  onSearch: (text: string) => void;
}) => (
  <div
    role="log"
    aria-label="Conversación con el analista"
    aria-busy={pending}
    className={styles.thread}
  >
    {turns.map((turn) => (
      <Fragment key={turn.id}>
        <article className={styles.user} aria-label="Tu pregunta">
          <p className={styles.bubble}>{turn.question}</p>
        </article>
        <AssistantTurn turn={turn} onSearch={onSearch} />
      </Fragment>
    ))}
  </div>
);
