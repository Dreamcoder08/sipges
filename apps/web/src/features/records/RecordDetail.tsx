import type { ModuleRecord } from '@mascli/contracts';
import { displayValue, fieldValue, safePublicUrl } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

export const RecordDetail = ({
  module,
  record,
}: {
  module: RecordModule;
  record: ModuleRecord;
}) => (
  <dl className={styles.details}>
    {MODULES[module].fields.map((field) => {
      const value = fieldValue(record, field);
      const url = field.type === 'url' ? safePublicUrl(value) : null;
      return (
        <div key={field.key}>
          <dt>{field.label}</dt>
          <dd>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                {url}
              </a>
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
);
