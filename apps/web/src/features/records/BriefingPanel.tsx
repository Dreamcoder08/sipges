import type { Briefing } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { presentText } from './model.ts';
import { briefingQuery } from './ontology-api.ts';
import styles from './Records.module.css';

type Source = Briefing['sources'][number];

const Cite = ({ refs, sources }: { refs: readonly number[]; sources: readonly Source[] }) =>
  refs.length ? (
    <sup className={styles.cites}>
      {refs.map((ref) => {
        const source = sources.find((s) => s.ref === ref);
        return source ? (
          <InternalLink
            key={ref}
            href={objectHref(source.module, source.id)}
            aria-label={`Fuente ${ref}: ${source.type_label} ${source.id}`}
          >
            [{ref}]
          </InternalLink>
        ) : null;
      })}
    </sup>
  ) : null;

/** Splits "texto [2] más [3]" into text and citation links. */
const Narrative = ({ text, sources }: { text: string; sources: readonly Source[] }) => (
  <p className={styles.narrative}>
    {text.split(/(\[\d{1,4}\])/).map((part, index) => {
      const ref = /^\[(\d{1,4})\]$/.exec(part)?.[1];
      return ref ? (
        <Cite key={index} refs={[Number(ref)]} sources={sources} />
      ) : (
        <span key={index}>{presentText(part)}</span>
      );
    })}
  </p>
);

/** Cited briefing of one record (docs/adr/0013); generated on request. */
export const BriefingPanel = ({
  module,
  id,
  scope,
}: {
  module: string;
  id: string;
  scope: string;
}) => {
  const [requested, setRequested] = useState(false);
  const briefing = useQuery({ ...briefingQuery(module, id, scope), enabled: requested });
  return (
    <section className={styles.evidence} aria-labelledby={`briefing-${id}`}>
      <div className={styles.graphHeader}>
        <h4 id={`briefing-${id}`}>Informe del analista</h4>
        <Button
          variant="secondary"
          disabled={briefing.isFetching}
          onClick={() => (requested ? void briefing.refetch() : setRequested(true))}
        >
          {briefing.isFetching
            ? 'Generando…'
            : requested
              ? 'Actualizar informe'
              : 'Generar informe'}
        </Button>
      </div>
      {!requested ? (
        <p className={styles.muted}>
          Resume el registro, sus vínculos, su cronología y las señales de atención. Cada afirmación
          cita los registros de los que procede.
        </p>
      ) : (
        <QueryState query={briefing} label="el informe">
          {(data) => (
            <div className={styles.briefing}>
              {data.notice ? <Alert tone="info">{data.notice}</Alert> : null}
              {data.narrative ? (
                <>
                  <Narrative text={data.narrative.text} sources={data.sources} />
                  <p className={styles.muted}>
                    Redactado con asistencia de un modelo de lenguaje a partir del informe
                    extractivo; verifica las fuentes citadas.
                  </p>
                </>
              ) : null}
              {data.sections.map((section) => (
                <div key={section.title}>
                  <h5>{section.title}</h5>
                  <ul>
                    {section.sentences.map((sentence, index) => (
                      <li key={index}>
                        {presentText(sentence.text)}{' '}
                        <Cite refs={sentence.refs} sources={data.sources} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <h5>Fuentes</h5>
              <ol className={styles.sources} aria-label="Fuentes del informe">
                {data.sources.map((source) => (
                  <li key={source.ref} value={source.ref}>
                    <InternalLink href={objectHref(source.module, source.id)}>
                      {source.type_label} {source.id}
                    </InternalLink>{' '}
                    · {presentText(source.title)}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </QueryState>
      )}
    </section>
  );
};
