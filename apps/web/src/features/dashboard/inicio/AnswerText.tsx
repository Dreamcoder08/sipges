import { Fragment, type ReactNode } from 'react';
import { type AnalystSource, answerParts } from './ask.ts';
import { answerBlocks, boldParts, sourceName } from './answer-format.ts';

/**
 * The answer's text, safely formatted (odd/tasks/chat-first-ui.md T8): paragraphs, bold, bullet
 * and numbered lists, and [n] links to this answer's own sources. Built from React elements and
 * text only: no innerHTML, no Markdown library, and no link but a citation. Whatever else the
 * model writes (HTML, Markdown links, headings) is shown as the literal text it is.
 */
export const AnswerText = ({
  answer,
  sources,
  anchor,
  className,
}: {
  answer: string;
  sources: readonly AnalystSource[];
  /** The id of source n's entry in this answer's list of sources. */
  anchor: (n: number) => string;
  className?: string | undefined;
}) => {
  const cited = (text: string) =>
    answerParts(text, sources).map((part, index) =>
      'source' in part ? (
        <a
          key={index}
          data-cite=""
          href={`#${anchor(part.source.n)}`}
          aria-label={`Fuente ${part.source.n}: ${sourceName(part.source)}`}
        >
          [{part.source.n}]
        </a>
      ) : (
        part.text
      ),
    );
  const inline = (text: string): ReactNode =>
    boldParts(text).map((part, index) =>
      part.bold ? (
        <strong key={index}>{cited(part.text)}</strong>
      ) : (
        <Fragment key={index}>{cited(part.text)}</Fragment>
      ),
    );
  return (
    <div className={className} data-answer-text="">
      {answerBlocks(answer).map((block, index) =>
        block.kind === 'paragraph' ? (
          <p key={index}>{inline(block.text)}</p>
        ) : block.kind === 'bullets' ? (
          <ul key={index}>
            {block.items.map((item, at) => (
              <li key={at}>{inline(item)}</li>
            ))}
          </ul>
        ) : (
          <ol key={index} start={block.start === 1 ? undefined : block.start}>
            {block.items.map((item, at) => (
              <li key={at}>{inline(item)}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
};
