import type { ModuleRecord } from '@mascli/contracts';
import { limaToday } from '@mascli/kernel';
import { useId, useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { followupRows, type FollowupBucket } from './followup.ts';
import styles from './FollowupPanel.module.css';

type Filter = 'all' | FollowupBucket | 'unassigned';
const filters: readonly [Filter, string][] = [
  ['all', 'Todos'],
  ['overdue', 'Vencidos'],
  ['today', 'Vencen hoy'],
  ['upcoming', 'Próximos'],
  ['undated', 'Sin fecha válida'],
  ['unassigned', 'Sin responsable'],
  ['closed', 'Cerrados'],
];
const bucketLabel: Record<FollowupBucket, string> = {
  overdue: 'Vencido',
  today: 'Vence hoy',
  upcoming: 'Próximo',
  undated: 'Sin fecha válida',
  closed: 'Cerrado',
};

export const FollowupPanel = ({
  rows,
  module,
  onOpen,
}: {
  rows: readonly ModuleRecord[];
  module: 'acciones' | 'compromisos';
  onOpen: (id: string) => void;
}) => {
  const id = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const today = limaToday();
  const entries = followupRows(rows, today);
  const matches = (entry: (typeof entries)[number], key: Filter) =>
    key === 'all' || (key === 'unassigned' ? entry.unassigned : entry.bucket === key);
  const visible = entries.filter((entry) => matches(entry, filter));
  const pages = Math.max(1, Math.ceil(visible.length / 50));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Agenda del proyecto</p>
          <h4 id={id}>Seguimiento de {module === 'acciones' ? 'acciones' : 'compromisos'}</h4>
        </div>
        <span>
          {rows.length} {rows.length === 1 ? 'registro' : 'registros'}
        </span>
      </div>
      <p className={styles.explanation}>
        Fecha de referencia: {today} (America/Lima). Los plazos de texto se conservan sin inferir
        fechas. Los estados cerrados no cuentan como vencidos.
      </p>
      <div className={styles.filters} role="group" aria-label="Filtrar seguimiento">
        {filters.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => {
              setFilter(key);
              setPage(0);
            }}
          >
            {label}: {entries.filter((entry) => matches(entry, key)).length}
          </button>
        ))}
      </div>
      <p role="status" className={styles.explanation}>
        {visible.length} {visible.length === 1 ? 'registro' : 'registros'} en la selección
      </p>
      {visible.length ? (
        <ul className={styles.list}>
          {visible
            .slice(currentPage * 50, (currentPage + 1) * 50)
            .map(({ row, dueDate, rawDeadline, bucket, unassigned }) => (
              <li key={row._id}>
                <div className={styles.details}>
                  <strong>
                    {String((module === 'acciones' ? row.Accion : row.Descripcion) || row._id)}
                  </strong>
                  <span className={`${styles.badge} ${styles[bucket]}`}>{bucketLabel[bucket]}</span>
                  <span>
                    Responsable: {unassigned ? 'Sin responsable' : String(row.Responsable)}
                  </span>
                  <span>Estado: {String(row.Estado || 'Sin estado registrado')}</span>
                  <span>
                    Plazo:{' '}
                    {dueDate ? (
                      <time dateTime={dueDate}>{dueDate}</time>
                    ) : (
                      rawDeadline || 'Sin registrar'
                    )}
                  </span>
                  {row.Plazo && String(row.Plazo) !== (dueDate ?? rawDeadline) ? (
                    <small>Plazo original: {String(row.Plazo)}</small>
                  ) : null}
                </div>
                <Button
                  variant="secondary"
                  data-return={`insight-${row._id}`}
                  data-return-key={`insight-${row._id}`}
                  onClick={() => onOpen(row._id)}
                >
                  Abrir {module === 'acciones' ? 'acción' : 'compromiso'} {row._id}
                </Button>
              </li>
            ))}
        </ul>
      ) : (
        <p>No hay registros para este filtro.</p>
      )}
      {pages > 1 ? (
        <div className={styles.filters}>
          <Button
            variant="secondary"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Seguimientos anteriores
          </Button>
          <p>
            Página {currentPage + 1} de {pages}
          </p>
          <Button
            variant="secondary"
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Más seguimientos
          </Button>
        </div>
      ) : null}
    </section>
  );
};
