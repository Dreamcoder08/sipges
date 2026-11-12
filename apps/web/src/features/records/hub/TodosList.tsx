import { type ReactNode, useRef, useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { EmptyState } from '../../../shared/ui/EmptyState.tsx';
import { Field } from '../../../shared/ui/Field.tsx';
import { type ActiveFilter, ActiveFilters, FilterGroup, FilterSheet } from '../FilterSheet.tsx';
import { MODULES } from '../modules.ts';
import styles from './Hub.module.css';
import type { OpenRecord } from './RecordSheet.tsx';
import {
  type RecordSummary,
  VALIDATION_STATES,
  VERIFICATION_LETTERS,
  type VerificationLetter,
} from './summary.ts';
import { TypeChip } from './TypeChip.tsx';
import { ValidationChip, VerificationChip } from './VerificationChip.tsx';

const matches = (row: RecordSummary, query: string) =>
  !query ||
  [row.id, row.title, row.territory, MODULES[row.module].label].some((text) =>
    text.toLowerCase().includes(query),
  );

/** Every record type in one list, filtered by search and, in one sheet, A–E and validation. */
export const TodosList = ({
  rows,
  onOpen,
  density,
  narrow,
}: {
  rows: readonly RecordSummary[];
  onOpen: (record: OpenRecord) => void;
  /** The density control, drawn at the right end of the toolbar. */
  density: ReactNode;
  /** A docked sheet is open: the optional columns give way to it. */
  narrow: boolean;
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
  const filtersButton = useRef<HTMLButtonElement>(null);
  const active: ActiveFilter[] = [
    ...(letter
      ? [{ id: 'letter', label: `Verificación ${letter}`, remove: () => setLetter(null) }]
      : []),
    ...(validation
      ? [
          {
            id: 'validation',
            label: `Validación: ${validation}`,
            remove: () => setValidation(null),
          },
        ]
      : []),
  ];
  const clear = () => {
    setLetter(null);
    setValidation(null);
  };
  return (
    <>
      <div role="group" aria-label="Filtros de registros" className={styles.toolbar}>
        <div className={styles.search}>
          <Field
            label="Buscar en registros"
            type="search"
            placeholder="Buscar por ID o título…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <FilterSheet
          active={active}
          shown={visible.length}
          onClear={clear}
          buttonRef={filtersButton}
        >
          <FilterGroup label="Verificación A a E">
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
          </FilterGroup>
          <FilterGroup label="Validación">
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
          </FilterGroup>
        </FilterSheet>
        <div className={styles.toolbarEnd}>
          {density}
          <p className={styles.shown} role="status">
            {visible.length} de {rows.length} registros
          </p>
        </div>
      </div>
      <ActiveFilters active={active} onClear={clear} fallback={filtersButton} />
      {visible.length ? (
        <div
          className={styles.tableWrap}
          data-narrow={narrow}
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
                <th scope="col" className={styles.optional}>
                  Territorio
                </th>
                <th scope="col" className={styles.optional}>
                  Fecha
                </th>
                <th scope="col">
                  <span title="A = mayor confianza, E = menor">Verif.</span>
                </th>
                <th scope="col" className={styles.optional}>
                  Validación
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={`${row.module}/${row.id}`}>
                  <td className={styles.id}>{row.id}</td>
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
                  <td>
                    <TypeChip module={row.module} />
                  </td>
                  <td className={styles.optional}>
                    {row.territory || <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.optional}>
                    {row.date || <span className={styles.muted}>—</span>}
                  </td>
                  <td>
                    <VerificationChip letter={row.verification} />
                  </td>
                  <td className={styles.optional}>
                    <ValidationChip state={row.validation} />
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
                clear();
              }}
            >
              Mostrar todos los registros
            </Button>
          }
        >
          Prueba con otra búsqueda o quita la verificación o la validación elegidas.
        </EmptyState>
      )}
    </>
  );
};
