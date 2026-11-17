import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useMediaQuery } from '../../../shared/lib/media.ts';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { QueryState } from '../../../shared/ui/QueryState.tsx';
import { type AttentionQuery, Cards, Head, LABEL, calm } from './Attention.tsx';
import styles from './Attention.module.css';

/** Phones show the bell (the stylesheet's phone layout uses the same width). */
const PHONE_QUERY = '(max-width: 40rem)';

/**
 * During a conversation the urgent items wait behind a «Necesita tu atención N» button in
 * Inicio's top bar (direction 01, L10); a bell with the count on phones. The count is never
 * hidden: with nothing urgent the button stays, disabled, and says «Nada urgente».
 *
 * The panel is a disclosure anchored under its button rather than a native `popover`: anchor
 * positioning is not yet in Chromium or Firefox, and an unanchored popover opens centred on the
 * screen. It keeps the popover's contract: focus moves in, Esc and a press outside close it and
 * give focus back to the button, Tab past its end closes it.
 */
export const AttentionPopover = ({
  query,
  children,
}: {
  query: AttentionQuery;
  /** Shown after the list: «Esta semana», which stays reachable during a conversation. */
  children?: ReactNode;
}) => {
  const phone = useMediaQuery(PHONE_QUERY);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const headId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const count = query.data?.length;
  const none = count === 0;

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  // Focus enters the panel on its first link (or the panel itself while it loads).
  useEffect(() => {
    if (!open) return;
    const target = panel.current?.querySelector<HTMLElement>('a[href], button:not([disabled])');
    (target ?? panel.current)?.focus();
  }, [open]);

  // A press anywhere else closes it, as a light-dismiss popover does.
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (root.current?.contains(event.target as Node)) return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    close();
  };
  const onBlur = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !root.current?.contains(next)) setOpen(false);
  };

  const name = none
    ? 'Nada urgente'
    : count === undefined
      ? 'Necesita tu atención'
      : `Necesita tu atención: ${count}`;

  return (
    <div ref={root} className={styles.anchor} onKeyDown={onKey} onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        className={phone ? styles.bell : styles.trigger}
        disabled={none}
        aria-expanded={open}
        aria-controls={panelId}
        {...(phone ? { 'aria-label': name, title: name } : {})}
        onClick={() => setOpen((shown) => !shown)}
      >
        {phone ? (
          <>
            <Icon name="bell" />
            {count ? <span className={styles.badge}>{count}</span> : null}
          </>
        ) : none ? (
          'Nada urgente'
        ) : (
          <>
            Necesita tu atención
            {count ? <span className={styles.badge}>{count}</span> : null}
          </>
        )}
      </button>
      <div
        ref={panel}
        id={panelId}
        className={styles.panel}
        role="region"
        aria-labelledby={headId}
        tabIndex={-1}
        hidden={!open}
      >
        <Head id={headId} count={count} more={false} />
        <QueryState query={query} label={LABEL}>
          {(items) => (items.length ? <Cards items={items} /> : calm)}
        </QueryState>
        {children}
      </div>
    </div>
  );
};
