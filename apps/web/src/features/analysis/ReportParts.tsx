import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { downloadFile } from '../../shared/api/download.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { count } from '../../shared/lib/plural.ts';
import { keyWords } from '../../shared/lib/text.ts';
import styles from './Analysis.module.css';

/** How a column of stored fields is named on screen; never the stored key (functional-10 T3). */
export type FieldLabel = (key: string) => string;

const text = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
export const TextList = ({ items }: { items: readonly string[] }) =>
  items.length ? (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  ) : (
    <p>Sin elementos registrados.</p>
  );
export const Limitations = ({ items }: { items: readonly string[] }) => (
  <Card title="Alcance y limitaciones">
    <TextList items={items} />
  </Card>
);
export const Counts = ({ values }: { values: Record<string, number> }) => (
  <dl className={styles.metrics}>
    {Object.entries(values).map(([label, value]) => (
      <div key={label}>
        <dt>{keyWords(label)}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);
export const Tallies = ({ title, rows }: { title: string; rows: [string, number][] }) => (
  <Card title={title}>
    {rows.length ? (
      <ul>
        {rows.map(([label, count]) => (
          <li key={label}>
            {label}: {count}
          </li>
        ))}
      </ul>
    ) : (
      <p>Sin datos registrados.</p>
    )}
  </Card>
);
export const Excerpts = ({
  title,
  records,
  fieldLabel = keyWords,
}: {
  title: string;
  records: Array<{ id: string } & Record<string, unknown>>;
  fieldLabel?: FieldLabel | undefined;
}) => {
  const keys = [...new Set(records.flatMap(Object.keys))];
  const header = (key: string) => (key === 'id' ? 'Registro' : fieldLabel(key));
  return (
    <Card title={title}>
      {records.length ? (
        <div className={styles.table} tabIndex={0} role="region" aria-label={title}>
          <table>
            <caption>
              {title}: {count(records.length, 'registro', 'registros')}
            </caption>
            <thead>
              <tr>
                {keys.map((key) => (
                  <th key={key} scope="col">
                    {header(key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  {keys.map((key) => (
                    <td key={key}>{text(record[key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>Sin registros.</p>
      )}
    </Card>
  );
};
export const ReportDownload = ({
  scope,
  path,
  filename,
  label,
}: {
  scope: string;
  path: string;
  filename: string;
  label: string;
}) => {
  const lock = useRef(false);
  const mutation = useMutation({ mutationFn: () => downloadFile(scope, path, filename) });
  const run = async () => {
    if (lock.current) return;
    lock.current = true;
    try {
      await mutation.mutateAsync();
    } catch {
      /* Mutation exposes failure. */
    } finally {
      lock.current = false;
    }
  };
  return (
    <div>
      <Button variant="secondary" disabled={mutation.isPending} onClick={() => void run()}>
        {mutation.isPending ? 'Preparando descarga…' : label}
      </Button>
      {mutation.error ? <Alert tone="error">{errorDetail(mutation.error)}</Alert> : null}
    </div>
  );
};
