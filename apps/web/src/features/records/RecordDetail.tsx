import type { ModuleRecord } from '@sipges/contracts';
import { AlertExplanation, EXPLANATION_KEYS, isExplainedAlert } from './AlertExplanation.tsx';
import { displayValue, extraFields, fieldValue, safePublicUrl } from './model.ts';
import { MODULES, recordFieldLabel, type RecordModule } from './modules.ts';
import { dimensionLabel, isDimension } from '../../shared/lib/text.ts';
import styles from './Records.module.css';
import { DateText } from '../../shared/ui/DateText.tsx';

export const RecordDetail = ({
  module,
  record,
}: {
  module: RecordModule;
  record: ModuleRecord;
}) => {
  const explained = module === 'alertas' && isExplainedAlert(record);
  const extras = extraFields(module, record).filter(
    (field) =>
      !(explained && EXPLANATION_KEYS.includes(field.key)) &&
      // The module's own id key repeats «Código del registro» (functional-10 T16).
      !(/^ID_/.test(field.key) && field.value === record._id),
  );
  return (
    <>
      <dl className={styles.details}>
        {MODULES[module].fields.map((field) => {
          const value = fieldValue(record, field);
          const url = field.type === 'url' ? safePublicUrl(value) : null;
          return (
            <div key={field.key} className={field.type === 'textarea' ? styles.wide : undefined}>
              <dt>{field.label}</dt>
              <dd>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {url}
                  </a>
                ) : field.type === 'url' && /^https?:\/\/[^/]+\.invalid(?:[/:]|$)/i.test(value) ? (
                  'Sin enlace público'
                ) : field.type === 'date' ? (
                  <DateText value={value} fallback="Sin registrar" />
                ) : field.key.startsWith('Dimension') && isDimension(value) ? (
                  dimensionLabel(value)
                ) : (
                  value || 'Sin registrar'
                )}
              </dd>
            </div>
          );
        })}
        <div>
          <dt>Código del registro</dt>
          <dd>{displayValue(record._id)}</dd>
        </div>
      </dl>
      {explained ? <AlertExplanation record={record} /> : null}
      {extras.length ? (
        <section aria-labelledby={`extras-${record._id}`}>
          <h3 id={`extras-${record._id}`}>Otros datos del registro</h3>
          <dl className={styles.details}>
            {extras.map((field) => (
              <div key={field.key}>
                <dt>{recordFieldLabel(module, field.key)}</dt>
                <dd>{displayValue(field.value) || 'Sin registrar'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  );
};
