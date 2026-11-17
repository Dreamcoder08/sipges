import { isApiError } from '../../../shared/api/client.ts';
import { InternalLink, objectHref } from '../../../shared/lib/navigation.tsx';
import { Alert } from '../../../shared/ui/Alert.tsx';
import { Button } from '../../../shared/ui/Button.tsx';
import { type AnalystAnswer as Answer, type AnalystSource, answerParts } from './ask.ts';
import { AnswerBlocks } from './AnswerBlocks.tsx';
import styles from './AnalystAnswer.module.css';

const sourceName = (source: AnalystSource) => source.title || source.id;
const anchor = (n: number) => `analista-fuente-${n}`;

/**
 * What the Inicio analyst answered (odd/tasks/agentic-analyst.md T1d). While it works a progress
 * bar shows it, without announcing it; the answer is announced politely, each [n] links to its
 * source and each source to its record; a failure is an alert, and when the analyst cannot answer
 * here the question can still search the records.
 */
export const AnalystAnswer = ({
  pending,
  question,
  data,
  error,
  onSearch,
}: {
  pending: boolean;
  question: string;
  /** Blocks may be missing in answers built before they existed (tests, cached data). */
  data?: (Omit<Answer, 'blocks'> & Partial<Pick<Answer, 'blocks'>>) | undefined;
  error?: unknown;
  onSearch: (text: string) => void;
}) => {
  // 409: external AI off; 503: no analyst on this installation, or its AI service is out of
  // reach (stopped, login expired, quota spent). The search still works.
  const searchInstead = isApiError(error, 409) || isApiError(error, 503);
  return (
    <section className={styles.panel} aria-label="Respuesta del analista">
      {pending ? (
        <progress className={styles.progress} aria-label="Preparando la respuesta" />
      ) : null}
      <div role="status">
        {data && !pending ? (
          <>
            <p className={styles.answer}>
              {answerParts(data.answer, data.sources).map((part, index) =>
                'source' in part ? (
                  <a
                    key={index}
                    className={styles.cite}
                    href={`#${anchor(part.source.n)}`}
                    aria-label={`Fuente ${part.source.n}: ${sourceName(part.source)}`}
                  >
                    [{part.source.n}]
                  </a>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </p>
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
      {data && !pending ? <AnswerBlocks blocks={data.blocks ?? []} /> : null}
      {error && !pending ? (
        <Alert tone="error">
          {isApiError(error) ? error.detail : 'No se pudo obtener la respuesta.'}
          {searchInstead ? (
            <>
              {' '}
              <Button variant="secondary" size="sm" onClick={() => onSearch(question)}>
                Buscar «{question}» en registros
              </Button>
            </>
          ) : null}
        </Alert>
      ) : null}
    </section>
  );
};
