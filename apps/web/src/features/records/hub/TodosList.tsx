import { useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { ChipRow } from '../../../shared/ui/ChipRow.tsx';
import { EmptyState } from '../../../shared/ui/EmptyState.tsx';
import { Field } from '../../../shared/ui/Field.tsx';
import { MODULES } from '../modules.ts';
import styles from './Hub.module.css';
import type { OpenRecord } from './RecordSheet.tsx';
import {
  type RecordSummary,
  VALIDATION_STATES,
  VERIFICATION_LETTERS,
  type VerificationLetter,
} from './summary.ts';
import { VerificationChip } from './VerificationChip.tsx';

const matches = (row: RecordSummary, query: string) =>
  !query ||
  [row.id, row.title, row.territory, MODULES[row.module].label].some((text) =>
    text.toLowerCase().includes(query),
  );

/** Every record type in one list, filtered by search, A–E verification and validation. */
export const TodosList = ({
  rows,
  onOpen,
}: {
  rows: readonly RecordSummary[];
  onOpen: (record: OpenRecord) => void;
}) => {
  const [query, setQuery] = useState('');
  const [letter, setLetter] = useState<VerificationLetter | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const visible = rows.filter(
    (row) =>
      matches(row, query.trim().toLowerCase()) &&
      (!letter || row.verification === letter) &&
      (!validation || row.validation === validation),
  );
  const toggle = <T extends string>(current: T | null, next: T, set: (value: T | null) => void) =>
    set(current === next ? null : next);
  return (
    <>
      <div className={styles.filters}>
        <Field
          label="Buscar en registros"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ChipRow label="Verificación A a E">
          {VERIFICATION_LETTERS.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={letter === item ? 'primary' : 'secondary'}
              aria-pressed={letter === item}
              title={`Verificación ${item}`}
              onClick={() => toggle(letter, item, setLetter)}
            >
              {item}
            </Button>
          ))}
        </ChipRow>
        <ChipRow label="Validación">
          {VALIDATION_STATES.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={validation === item ? 'primary' : 'secondary'}
              aria-pressed={validation === item}
              onClick={() => toggle(validation, item, setValidation)}
            >
              {item}
            </Button>
          ))}
        </ChipRow>
      </div>
      <p className={styles.muted} role="status">
        {visible.length} de {rows.length} registro(s) mostrados
      </p>
      {visible.length ? (
        <div
          className={styles.tableWrap}
          tabIndex={0}
          role="region"
          aria-label="Tabla de registros"
        >
          <table className={styles.table}>
            <caption className="visually-hidden">
              Registros de todos los tipos del proyecto activo
            </caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Registro</th>
                <th scope="col">Tipo</th>
                <th scope="col">Territorio</th>
                <th scope="col">Fecha</th>
                <th scope="col">Verif.</th>
                <th scope="col">Validación</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={`${row.module}/${row.id}`}>
                  <td>{row.id}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.open}
                      data-return={`abrir-${row.id}`}
                      onClick={() => onOpen({ module: row.module, id: row.id })}
                    >
                      <span className="visually-hidden">Abrir {row.id}: </span>
                      {row.title}
                    </button>
                  </td>
                  <td>{MODULES[row.module].label}</td>
                  <td>{row.territory || '—'}</td>
                  <td>{row.date || '—'}</td>
                  <td>
                    <VerificationChip letter={row.verification} />
                  </td>
                  <td>
                    {row.validation ? <span className={styles.pill}>{row.validation}</span> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="Ningún registro coincide con estos filtros."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery('');
                setLetter(null);
                setValidation(null);
              }}
            >
              Limpiar filtros
            </Button>
          }
        >
          Prueba con otra búsqueda o quita la verificación o la validación elegidas.
        </EmptyState>
      )}
    </>
  );
};
