import styles from './Hub.module.css';
import type { OpenRecord } from './RecordSheet.tsx';
import type { RecordSummary } from './summary.ts';
import { typeLabel } from './types.ts';
import { ValidationChip } from './VerificationChip.tsx';

/**
 * Todos and the type tabs below 1024 px (closure-roadmap T31, direction 01): one two-line row
 * per record instead of a table squeezed into a phone. Line 1 is the title on one line and the validation status;
 * line 2 the type, place, date and the A–E letter. The whole row is one button that opens the
 * record sheet; what a record lacks is left out rather than shown as a dash.
 */
export const RecordRows = ({
  rows,
  label,
  onOpen,
}: {
  rows: readonly RecordSummary[];
  label: string;
  onOpen: (record: OpenRecord) => void;
}) => (
  <ul className={styles.rows} aria-label={label}>
    {rows.map((row) => (
      <li key={`${row.module}/${row.id}`}>
        <button
          type="button"
          className={styles.row}
          data-return={`abrir-${row.id}`}
          onClick={() => onOpen({ module: row.module, id: row.id })}
        >
          <span className={styles.rowTop}>
            <span className={styles.rowTitle}>
              <span className="visually-hidden">Abrir {row.id}: </span>
              <span data-line="title">{row.title}</span>
            </span>
            {row.validation ? <ValidationChip state={row.validation} /> : null}
          </span>
          <span className={styles.rowMeta} data-line="meta">
            <span className={styles.rowFacts}>
              {[typeLabel(row.module), row.territory, row.date].filter(Boolean).join(' · ')}
            </span>
            {row.verification ? (
              <>
                <span className="visually-hidden"> Verificación </span>
                <span className={styles.ver} data-verification={row.verification}>
                  {row.verification}
                </span>
              </>
            ) : null}
          </span>
        </button>
      </li>
    ))}
  </ul>
);
