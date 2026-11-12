import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { EmptyState } from '../../../shared/ui/EmptyState.tsx';
import { Field } from '../../../shared/ui/Field.tsx';
import { type ActiveFilter, ActiveFilters, FilterGroup, FilterSheet } from '../FilterSheet.tsx';
import { MODULES } from '../modules.ts';
import styles from './Hub.module.css';
import { RecordRows } from './RecordRows.tsx';
import type { OpenRecord, OpenWay } from './RecordSheet.tsx';
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

const keyOf = (row: OpenRecord) => `${row.module}/${row.id}`;

/** The row a key moves to, or undefined when it does not move: the page keeps the key. */
const MOVES: Readonly<Record<string, (from: number, last: number) => number>> = {
  ArrowDown: (from, last) => Math.min(from + 1, last),
  ArrowUp: (from) => Math.max(from - 1, 0),
  Home: () => 0,
  End: (_from, last) => last,
};

/**
 * Every record type in one list, filtered by search and, in one sheet, A–E and validation.
 * The table is a grid with one tab stop: a click, Enter or Space on a row opens it, and the
 * arrows, Home and End move between rows. Beside a docked sheet the moves also select, so the
 * sheet follows the keyboard (closure-roadmap T31, direction 02). Below 1024 px, where the sheet
 * is modal, the records are a list of two-line rows instead (RecordRows, direction 01).
 */
export const TodosList = ({
  rows,
  onOpen,
  density,
  selected,
  docked,
  letter,
  onLetter: setLetter,
}: {
  rows: readonly RecordSummary[];
  onOpen: (record: OpenRecord, way: OpenWay) => void;
  /** The density control, drawn at the right end of the toolbar (desktop table only). */
  density: ReactNode;
  /** The record open in the sheet, marked with aria-selected. */
  selected: OpenRecord | null;
  /** The sheet docks beside the table (desktop): moving the selection opens the next record. */
  docked: boolean;
  /** The A–E filter, owned by the hub so the URL can carry it. */
  letter: VerificationLetter | null;
  onLetter: (letter: VerificationLetter | null) => void;
}) => {
  const captionId = useId();
  const [focused, setFocused] = useState<string | null>(null);
  const [query, setQuery] = useState('');
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
  const chosen = selected ? keyOf(selected) : null;
  const stop =
    [focused, chosen].find((key) => key && visible.some((row) => keyOf(row) === key)) ??
    (visible[0] ? keyOf(visible[0]) : null);
  const move = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const toward = MOVES[event.key];
    if (!toward || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const openers = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-opener]')];
    const from = openers.indexOf(event.target as HTMLElement);
    const to = from < 0 ? from : toward(from, openers.length - 1);
    const next = openers[to];
    const row = visible[to];
    if (to === from || !next || !row) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView?.({ block: 'nearest' });
    if (docked) onOpen({ module: row.module, id: row.id }, 'browse');
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
      {visible.length && !docked ? (
        <RecordRows
          rows={visible}
          label="Registros de todos los tipos del proyecto activo"
          onOpen={(record) => onOpen(record, 'select')}
        />
      ) : visible.length ? (
        <div
          className={styles.tableWrap}
          tabIndex={0}
          role="region"
          aria-label="Tabla de registros"
        >
          <table className={styles.table} role="grid" aria-labelledby={captionId}>
            <caption id={captionId} className="visually-hidden">
              Registros de todos los tipos del proyecto activo
            </caption>
            <thead>
              <tr>
                <th scope="col" className={styles.id}>
                  ID
                </th>
                <th scope="col">Registro</th>
                <th scope="col" className={styles.colType}>
                  Tipo
                </th>
                <th scope="col" className={styles.colPlace}>
                  Territorio
                </th>
                <th scope="col" className={styles.colDate}>
                  Fecha
                </th>
                <th scope="col" className={styles.colVerification}>
                  <span title="A = mayor confianza, E = menor">Verif.</span>
                </th>
                <th scope="col" className={styles.colState}>
                  Validación
                </th>
              </tr>
            </thead>
            <tbody
              onKeyDown={move}
              onFocus={(event) => setFocused(event.target.dataset.opener ?? null)}
            >
              {visible.map((row) => (
                <tr
                  key={keyOf(row)}
                  aria-selected={keyOf(row) === chosen}
                  onClick={(event) => {
                    // A click anywhere on the row selects it; Escape later returns here.
                    event.currentTarget.querySelector<HTMLElement>('[data-opener]')?.focus();
                    onOpen({ module: row.module, id: row.id }, 'select');
                  }}
                >
                  <td className={styles.id}>{row.id}</td>
                  <td className={styles.title}>
                    <button
                      type="button"
                      className={styles.open}
                      data-return={`abrir-${row.id}`}
                      data-opener={keyOf(row)}
                      tabIndex={keyOf(row) === stop ? 0 : -1}
                    >
                      <span className="visually-hidden">Abrir {row.id}: </span>
                      {row.title}
                    </button>
                  </td>
                  <td className={styles.colType}>
                    <TypeChip module={row.module} />
                  </td>
                  <td className={styles.colPlace}>
                    {row.territory || <span className={styles.muted}>—</span>}
                  </td>
                  <td className={styles.colDate}>
                    {row.date || <span className={styles.muted}>—</span>}
                  </td>
                  <td>
                    <VerificationChip letter={row.verification} />
                  </td>
                  <td>
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
