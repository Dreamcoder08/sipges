import type { ModuleRecord } from '@sipges/contracts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import styles from './Records.module.css';

/** Payload keys an alert created from a SIPGES situation carries (docs/adr/0020 §4). */
export const EXPLANATION_KEYS = ['Origen', 'Situacion', 'Explicacion', 'Registros_Relacionados'];

export const isExplainedAlert = (record: ModuleRecord) => record.Origen === 'SIPGES';

/** Why the alert was raised: the engine's reasons and links to the records behind them. */
export const AlertExplanation = ({ record }: { record: ModuleRecord }) => {
  const reasons = String(record.Explicacion ?? '')
    .split('\n')
    .filter(Boolean);
  const related = Array.isArray(record.Registros_Relacionados)
    ? record.Registros_Relacionados.filter((ref): ref is string => typeof ref === 'string')
    : [];
  return (
    <section aria-labelledby={`why-${record._id}`} className={styles.evidence}>
      <h4 id={`why-${record._id}`}>Por qué se generó esta alerta</h4>
      <p>Sugerida por SIPGES a partir de registros relacionados y confirmada por una persona.</p>
      <ul>
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {related.length ? (
        <p>
          Registros que la originaron:{' '}
          {related.map((ref, index) => {
            const [module = '', ...rest] = ref.split(':');
            const id = rest.join(':');
            return (
              <span key={ref}>
                {index ? ', ' : ''}
                <InternalLink href={objectHref(module.toLowerCase(), id)}>
                  {module} {id}
                </InternalLink>
              </span>
            );
          })}
        </p>
      ) : null}
    </section>
  );
};
