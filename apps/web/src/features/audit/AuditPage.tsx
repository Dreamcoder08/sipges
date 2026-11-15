import { AuditEntry } from '@sipges/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './AuditPage.module.css';
import { formatDateTime, formatNumber } from '../../shared/lib/format.ts';
import { count } from '../../shared/lib/plural.ts';
import { DateText } from '../../shared/ui/DateText.tsx';
import { auditActionLabel, auditModuleLabel } from './labels.ts';

/** Column names; on a phone each cell shows its own (`data-label`) in a stacked card. */
const COLUMNS = ['Fecha y hora (Lima)', 'Módulo', 'Registro', 'Acción', 'Detalle'] as const;

/** Server audit is scoped, append-only and restricted to administrators. */
export const AuditPage = ({ scope, projectLabel, role }: FeatureContext) => {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState('100');
  const query = useQuery({
    queryKey: ['audit', scope, limit],
    enabled: role === 'admin',
    queryFn: ({ signal }) =>
      requestJson(`/system/audit?limit=${limit}`, AuditEntry.array(), { scope, signal }),
  });
  if (role !== 'admin')
    return <Alert tone="info">Auditoría restringida al rol administrador.</Alert>;
  const needle = search.trim().toLocaleLowerCase('es');
  return (
    <div className={styles.page}>
      <p>
        Historial del proyecto <strong>{projectLabel}</strong> ({scope}), ordenado por fecha
        descendente. La búsqueda se aplica a los registros cargados.
      </p>
      <Card
        title="Consultar auditoría"
        action={
          <Button
            variant="secondary"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Actualizar auditoría
          </Button>
        }
      >
        <div className={styles.filters}>
          <Field
            label="Buscar en auditoría"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            hint="Módulo, identificador, acción o detalle."
          />
          <label>
            Registros recientes
            <select value={limit} onChange={(event) => setLimit(event.target.value)}>
              <option value="100">100</option>
              <option value="250">250</option>
              <option value="500">500</option>
            </select>
          </label>
        </div>
        <QueryState query={query} label="auditoría">
          {(entries) => {
            const filtered = entries.filter((entry) =>
              [
                entry.module,
                auditModuleLabel(entry.module),
                entry.record_id,
                entry.action,
                auditActionLabel(entry.action),
                entry.detail,
                entry.ts,
                formatDateTime(entry.ts),
              ].some((value) => value?.toLocaleLowerCase('es').includes(needle)),
            );
            return (
              <>
                <p aria-live="polite">
                  {formatNumber(filtered.length)} de{' '}
                  {count(entries.length, 'registro cargado', 'registros cargados')}.
                </p>
                {filtered.length ? (
                  // A long unspaced detail can make the table wider than its card: the scroll box
                  // is then reachable and named for the keyboard (as in Registros).
                  <div
                    className={styles.scroll}
                    tabIndex={0}
                    role="region"
                    aria-label="Tabla de auditoría"
                  >
                    <table>
                      <caption>Registro de operaciones del proyecto activo</caption>
                      <thead>
                        <tr>
                          {COLUMNS.map((column) => (
                            <th key={column} scope="col">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((entry) => (
                          <tr key={entry.id}>
                            <td data-label={COLUMNS[0]} className={styles.nowrap}>
                              <DateText value={entry.ts} time />
                            </td>
                            <td data-label={COLUMNS[1]}>{auditModuleLabel(entry.module)}</td>
                            <td data-label={COLUMNS[2]}>{entry.record_id ?? '—'}</td>
                            <td data-label={COLUMNS[3]}>{auditActionLabel(entry.action)}</td>
                            <td data-label={COLUMNS[4]}>{entry.detail ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>
                    {entries.length
                      ? 'No hay coincidencias para esta búsqueda.'
                      : 'No hay operaciones registradas en este proyecto.'}
                  </p>
                )}
              </>
            );
          }}
        </QueryState>
      </Card>
    </div>
  );
};
