import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { AnalystSource } from './ask.ts';
import { answerPlainText } from './answer-format.ts';
import styles from './AnswerActions.module.css';

/** What the page's status region says after «Copiar» (chat-first-ui T6). */
export const COPY_MESSAGES = {
  copied: 'Copiado.',
  refused: 'No se pudo copiar: el navegador no permitió usar el portapapeles.',
} as const;

/** How long «Copiado» stays beside the button. */
const SHOWN_MS = 2000;

/**
 * The actions under a completed answer (odd/tasks/chat-first-ui.md T6, artboard 01): «Copiar»
 * puts the answer and its numbered sources on the clipboard as plain text, and «Volver a
 * preguntar» asks the same question as a new turn. Always visible, never on hover only.
 *
 * The result is shown beside the button and said once by the page's status region (`onAnnounce`):
 * the conversation log would read any text added inside it, so the visible note is hidden from
 * assistive technology to keep it to one announcement (L5, modern-web-guidance copy-button).
 */
export const AnswerActions = ({
  answer,
  sources,
  onRetry,
  onAnnounce,
  busy = false,
}: {
  answer: string;
  sources: readonly AnalystSource[];
  onRetry?: (() => void) | undefined;
  onAnnounce?: ((message: string) => void) | undefined;
  /** Another answer is pending: asking again waits for it. */
  busy?: boolean;
}) => {
  const [result, setResult] = useState<keyof typeof COPY_MESSAGES | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    // Copying again restarts the feedback; the button is never disabled meanwhile.
    window.clearTimeout(timer.current);
    setResult(null);
    let outcome: keyof typeof COPY_MESSAGES;
    try {
      // A missing clipboard (an insecure context) throws here too, and is reported the same way.
      await navigator.clipboard.writeText(answerPlainText(answer, sources));
      outcome = 'copied';
    } catch {
      outcome = 'refused';
    }
    setResult(outcome);
    onAnnounce?.(COPY_MESSAGES[outcome]);
    if (outcome === 'copied') timer.current = window.setTimeout(() => setResult(null), SHOWN_MS);
  };

  return (
    <div className={styles.acts} role="group" aria-label="Acciones de la respuesta">
      <button
        type="button"
        className={styles.act}
        data-copied={result === 'copied' || undefined}
        onClick={() => void copy()}
      >
        <Icon name={result === 'copied' ? 'check' : 'copy'} />
        Copiar
      </button>
      {onRetry ? (
        <button
          type="button"
          className={styles.act}
          aria-disabled={busy || undefined}
          title={busy ? 'Espera a que termine la respuesta en curso' : undefined}
          onClick={busy ? undefined : onRetry}
        >
          <Icon name="retry" />
          Volver a preguntar
        </button>
      ) : null}
      {result ? (
        <span className={result === 'copied' ? styles.note : styles.refused} aria-hidden="true">
          {result === 'copied' ? 'Copiado' : COPY_MESSAGES.refused}
        </span>
      ) : null}
    </div>
  );
};
