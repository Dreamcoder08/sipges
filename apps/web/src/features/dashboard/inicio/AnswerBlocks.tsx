import { type ReactNode, useId } from 'react';
import { InternalLink, objectHref } from '../../../shared/lib/navigation.tsx';
import { Alert } from '../../../shared/ui/Alert.tsx';
import { DateText } from '../../../shared/ui/DateText.tsx';
import type { AnalystBlock, AnalystSource } from './ask.ts';
import styles from './AnswerBlocks.module.css';

const recordName = (source: AnalystSource) => source.title || source.id;

const RecordLink = ({ source }: { source: AnalystSource }) => (
  <InternalLink href={objectHref(source.module, source.id)}>{recordName(source)}</InternalLink>
);

const Where = ({ source }: { source: AnalystSource }) => (
  <p className={styles.where}>
    {source.module} · {source.id}
  </p>
);

/** A card on one record: heading, then its content; named by its heading. */
const BlockCard = ({ title, children }: { title: ReactNode; children: ReactNode }) => {
  const heading = useId();
  return (
    <article className={styles.card} aria-labelledby={heading}>
      <h3 id={heading} className={styles.title}>
        {title}
      </h3>
      {children}
    </article>
  );
};

const Block = ({ block }: { block: AnalystBlock }) => {
  switch (block.type) {
    case 'record':
      return (
        <BlockCard title={<RecordLink source={block} />}>
          <Where source={block} />
        </BlockCard>
      );
    case 'alert':
      // The model's text is shown as text: React escapes it, nothing is parsed as markup.
      return (
        <Alert tone="warning">
          <p className={styles.alertText}>{block.text}</p>
          <RecordLink source={block} />
        </Alert>
      );
    case 'map':
      return (
        <BlockCard title={<>{recordName(block)} en el mapa</>}>
          <p className={styles.actions}>
            <RecordLink source={block} />
            <InternalLink href="/mapa">Abrir el mapa territorial</InternalLink>
          </p>
        </BlockCard>
      );
    case 'timeline':
      return (
        <BlockCard title={<>Cronología de {recordName(block)}</>}>
          <ol className={styles.events}>
            {block.entries.map((entry, index) => (
              <li key={index}>
                <DateText value={entry.date} /> <span>{entry.text}</span>
              </li>
            ))}
          </ol>
          <RecordLink source={block} />
        </BlockCard>
      );
  }
};

/**
 * The typed blocks of an analyst answer (odd/tasks/agentic-analyst.md S3): a record card, an alert
 * card, a record on the map and a timeline excerpt, each drawn from data, never from markup.
 */
export const AnswerBlocks = ({ blocks }: { blocks: readonly AnalystBlock[] }) =>
  blocks.length ? (
    <ul className={styles.blocks} aria-label="Detalles de la respuesta">
      {blocks.map((block) => (
        <li key={`${block.type}-${block.n}`}>
          <Block block={block} />
        </li>
      ))}
    </ul>
  ) : null;
