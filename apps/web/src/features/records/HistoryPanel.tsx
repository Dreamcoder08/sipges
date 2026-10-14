import type { RecordVersion } from '@mascli/contracts';
import { useQuery } from '@tanstack/react-query';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { historyQuery } from './api.ts';
import { displayValue } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

const OPERATIONS: Record<RecordVersion['operation'], string> = {
  BASELINE: 'Estado inicial',
  CREATE: 'Creación',
  UPDATE: 'Actualización',
  DELETE: 'Eliminación',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' });

const shown = (value: unknown) => (value === undefined ? '—' : displayValue(value) || '—');

/** Who changed what and when (docs/adr/0011 §4), newest version first. */
export const HistoryPanel = ({
  module,
  id,
  scope,
}: {
  module: RecordModule;
  id: string;
  scope: string;
}) => {
  const history = useQuery(historyQuery(module, scope, id));
  const labels = new Map(MODULES[module].fields.map((field) => [field.key, field.label]));
  return (
    <section className={styles.evidence} aria-labelledby={`history-${id}`}>
      <h4 id={`history-${id}`}>Historial de cambios</h4>
      <QueryState query={history} label="el historial">
        {(versions) => (
          <ol className={styles.history}>
            {versions.map((version) => (
              <li key={version.version}>
                <p>
                  <strong>
                    v{version.version} · {OPERATIONS[version.operation]}
                  </strong>{' '}
                  <small>
                    {version.actor} · <time dateTime={version.at}>{when(version.at)}</time>
                  </small>
                </p>
                {version.operation === 'UPDATE' && version.changes.length ? (
                  <ul>
                    {version.changes.map((change) => (
                      <li key={change.field}>
                        <span>{labels.get(change.field) ?? change.field}:</span>{' '}
                        <del>{shown(change.before)}</del> → <ins>{shown(change.after)}</ins>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </QueryState>
    </section>
  );
};
