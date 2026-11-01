import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '../../../shared/ui/Button.tsx';
import { Icon } from '../../../shared/ui/Icon.tsx';
import type { IconName } from '../../../shared/ui/icons.ts';
import type { RecordModule } from '../modules.ts';
import styles from './Hub.module.css';

/**
 * An action that first needs a record type («Nuevo registro», «Importar»): it lists the types
 * and hands the chosen one back; the type screen then runs its own form or import.
 */
export const TypePicker = ({
  label,
  menuLabel,
  icon,
  primary,
  types,
  onPick,
}: {
  label: string;
  menuLabel: string;
  icon: IconName;
  primary?: boolean;
  types: readonly (readonly [RecordModule, string])[];
  onPick: (module: RecordModule) => void;
}) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const move = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  };
  return (
    <div ref={root} className={styles.picker} onKeyDown={move}>
      <Button
        ref={trigger}
        size="sm"
        variant={primary ? 'primary' : 'secondary'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={icon} />
        {label}
      </Button>
      {open ? (
        <div role="menu" aria-label={menuLabel} className={styles.menu}>
          {types.map(([module, name]) => (
            <button
              key={module}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                onPick(module);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
