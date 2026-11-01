import type { RecordVersion } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { historyQuery } from './api.ts';
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

/**
 * A changed value as a person reads it. Lists and objects (attachments, follow-up data) were
 * shown as raw JSON; an attachment reads as its file name and type.
 */
export const readable = (value: unknown): string => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const file = (value as Record<string, unknown>).archivo;
    if (typeof file === 'string') {
      const kind = (value as Record<string, unknown>).tipo;
      return typeof kind === 'string' && kind ? `${file} (${kind})` : file;
    }
    return entries
      .map(([key, item]) => `${key}: ${readable(item)}`)
      .filter((text) => !text.endsWith(': '))
      .join(' · ');
  }
  return String(value);
};
const shown = (value: unknown) => (value === undefined ? '—' : readable(value) || '—');

/** Fields whose change counts as a review: status, verification or validation. */
const REVIEW_FIELD = /estado|verificacion|validacion/i;

/**
 * Who registered the record, who last changed it and who last reviewed it, from the
 * append-only history (docs/adr/0020, S9). Versions arrive newest first.
 */
export const traceability = (versions: readonly RecordVersion[]) => {
  const origin = versions.findLast((v) => v.operation === 'CREATE' || v.operation === 'BASELINE');
  const latest = versions[0];
  const review = versions.find(
    (v) => v.operation === 'UPDATE' && v.changes.some((c) => REVIEW_FIELD.test(c.field)),
  );
  return { origin, latest: latest === origin ? undefined : latest, review };
};

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
          <>
            <TraceSummary versions={versions} labels={labels} />
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
          </>
        )}
      </QueryState>
    </section>
  );
};

const TraceSummary = ({
  versions,
  labels,
}: {
  versions: readonly RecordVersion[];
  labels: ReadonlyMap<string, string>;
}) => {
  const { origin, latest, review } = traceability(versions);
  const reviewed = review?.changes.filter((c) => REVIEW_FIELD.test(c.field)) ?? [];
  return (
    <dl className={styles.details} aria-label="Trazabilidad del registro">
      <div>
        <dt>Registrado por</dt>
        <dd>
          {origin ? (
            <>
              {origin.actor} · <time dateTime={origin.at}>{when(origin.at)}</time>
              {origin.operation === 'BASELINE' ? ' (estado inicial migrado)' : ''}
            </>
          ) : (
            'Sin registro de creación'
          )}
        </dd>
      </div>
      <div>
        <dt>Revisado por</dt>
        <dd>
          {review ? (
            <>
              {review.actor} · <time dateTime={review.at}>{when(review.at)}</time> ·{' '}
              {reviewed
                .map((c) => `${labels.get(c.field) ?? c.field}: ${shown(c.after)}`)
                .join(' · ')}
            </>
          ) : (
            'Aún sin revisión de estado'
          )}
        </dd>
      </div>
      <div>
        <dt>Última modificación</dt>
        <dd>
          {latest ? (
            <>
              {latest.actor} · <time dateTime={latest.at}>{when(latest.at)}</time> ·{' '}
              {latest.changes.length} campo(s) cambiado(s)
            </>
          ) : (
            'Sin cambios desde su registro'
          )}
        </dd>
      </div>
    </dl>
  );
};
