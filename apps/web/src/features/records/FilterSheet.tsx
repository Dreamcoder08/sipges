import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../shared/ui/Button.tsx';
import { Icon } from '../../shared/ui/Icon.tsx';
import { Sheet } from '../../shared/ui/Sheet.tsx';
import styles from './FilterSheet.module.css';

/** One filter in force: its chip reads `label` and removes it with `remove`. */
export type ActiveFilter = { id: string; label: string; remove: () => void };

const records = (n: number) => `${n} ${n === 1 ? 'registro' : 'registros'}`;

/**
 * The one «Filtros» button of a record list (odd/tasks/closure-roadmap.md T31): it shows how many
 * filters are in force and opens every facet in one sheet, a bottom sheet on phones and a panel
 * on wide screens, instead of stacking them above the first row.
 */
export const FilterSheet = ({
  active,
  shown,
  onClear,
  buttonRef,
  children,
}: {
  active: readonly ActiveFilter[];
  /** Rows the current filters let through, for «Ver N registros». */
  shown: number;
  onClear: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={buttonRef}
        size="sm"
        variant="secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="sliders" />
        Filtros
        {active.length ? <span className={styles.count}> {active.length}</span> : null}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Filtros">
        <div className={styles.body}>{children}</div>
        <div className={styles.foot}>
          <Button variant="ghost" disabled={!active.length} onClick={onClear}>
            Limpiar filtros
          </Button>
          <Button onClick={() => setOpen(false)}>Ver {records(shown)}</Button>
        </div>
      </Sheet>
    </>
  );
};

/** A titled set of choices inside the sheet. */
export const FilterGroup = ({ label, children }: { label: string; children: ReactNode }) => (
  <fieldset className={styles.group}>
    <legend>{label}</legend>
    <div className={styles.options}>{children}</div>
  </fieldset>
);

/**
 * The filters in force as chips under the search, each a button that removes its filter. Focus
 * moves to the next chip, or back to «Filtros» when none is left, so it never drops to the page.
 */
export const ActiveFilters = ({
  active,
  onClear,
  fallback,
}: {
  active: readonly ActiveFilter[];
  onClear: () => void;
  fallback: RefObject<HTMLButtonElement | null>;
}) => {
  const group = useRef<HTMLDivElement>(null);
  const removed = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (removed.current === null) return;
    const chips = [...(group.current?.querySelectorAll<HTMLElement>('[data-chip]') ?? [])];
    (chips[Math.min(removed.current, chips.length - 1)] ?? fallback.current)?.focus();
    removed.current = null;
  });
  if (!active.length) return null;
  return (
    <div ref={group} role="group" aria-label="Filtros activos" className={styles.active}>
      {active.map((filter, index) => (
        <button
          key={filter.id}
          type="button"
          data-chip
          className={styles.chip}
          aria-label={`Quitar filtro ${filter.label}`}
          onClick={() => {
            removed.current = index;
            filter.remove();
          }}
        >
          {filter.label}
          <Icon name="close" />
        </button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          removed.current = Infinity;
          onClear();
        }}
      >
        Limpiar filtros
      </Button>
    </div>
  );
};
