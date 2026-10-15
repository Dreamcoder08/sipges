import type { ModuleRecord } from '@mascli/contracts';
import { displayValue, extraFields, fieldValue, safePublicUrl } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

export const RecordDetail = ({
  module,
  record,
}: {
  module: RecordModule;
  record: ModuleRecord;
}) => {
  const extras = extraFields(module, record);
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
      {extras.length ? (
        <section aria-labelledby={`extras-${record._id}`}>
          <h4 id={`extras-${record._id}`}>Otros datos del registro</h4>
          <dl className={styles.details}>
            {extras.map((field) => (
              <div key={field.key}>
                <dt>{field.key}</dt>
                <dd>{displayValue(field.value) || 'Sin registrar'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  );
};
