import { useId } from 'react';
import { isApiError } from '../../../shared/api/client.ts';
import { InternalLink, objectHref } from '../../../shared/lib/navigation.tsx';
import { Alert } from '../../../shared/ui/Alert.tsx';
import { Button } from '../../../shared/ui/Button.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { AnalystAnswer as Answer } from './ask.ts';
import { sourceName } from './answer-format.ts';
import { AnswerBlocks } from './AnswerBlocks.tsx';
import { AnswerText } from './AnswerText.tsx';
import styles from './AnalystAnswer.module.css';

/**
 * What the Inicio analyst answered (odd/tasks/agentic-analyst.md T1d), as one turn of the
 * conversation (chat-first-ui T5): each [n] links to its source in this turn and each source to its
 * record; when the analyst cannot answer here the question can still search the records, or be
 * asked again. The text is formatted safely (chat-first-ui T8, `AnswerText.tsx`). It holds no live
 * region: the conversation log reads it once, and the page announces start and end.
 */
export const AnalystAnswer = ({
  question,
  data,
  error,
  onSearch,
  onRetry,
}: {
  question: string;
  /** Blocks may be missing in answers built before they existed (tests, cached data). */
  data?: (Omit<Answer, 'blocks'> & Partial<Pick<Answer, 'blocks'>>) | undefined;
  error?: unknown;
  onSearch: (text: string) => void;
  /** «Volver a preguntar» after a failure (chat-first-ui T6); absent where asking again cannot. */
  onRetry?: (() => void) | undefined;
}) => {
  // 409: external AI off; 503: no analyst on this installation, or its AI service is out of
  // reach (stopped, login expired, quota spent). The search still works.
  const searchInstead = isApiError(error, 409) || isApiError(error, 503);
  // Several answers share the page: each one's [n] must reach its own list of sources.
  const prefix = useId();
  const anchor = (n: number) => `${prefix}fuente-${n}`;
  return (
    <section className={styles.panel} aria-label="Respuesta del analista">
      <div>
        {data ? (
          <>
            <AnswerText
              className={styles.answer}
              answer={data.answer}
              sources={data.sources}
              anchor={anchor}
            />
            {data.sources.length ? (
              <ol className={styles.sources} aria-label="Fuentes citadas">
                {data.sources.map((source) => (
                  <li key={source.n} id={anchor(source.n)} value={source.n}>
                    <InternalLink href={objectHref(source.module, source.id)}>
                      {sourceName(source)}
                    </InternalLink>{' '}
                    <small className={styles.module}>
                      {source.module} · {source.id}
                    </small>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : null}
      </div>
      {data ? <AnswerBlocks blocks={data.blocks ?? []} /> : null}
      {error ? (
        <Alert tone="error" announce={false}>
          {isApiError(error) ? error.detail : 'No se pudo obtener la respuesta.'}
          {searchInstead || onRetry ? (
            <span className={styles.recover}>
              {searchInstead ? (
                <Button variant="secondary" size="sm" onClick={() => onSearch(question)}>
                  Buscar «{question}» en registros
                </Button>
              ) : null}
              {onRetry ? (
                <Button variant="ghost" size="sm" onClick={onRetry}>
                  <Icon name="retry" />
                  Volver a preguntar
                </Button>
              ) : null}
            </span>
          ) : null}
        </Alert>
      ) : null}
    </section>
  );
};
