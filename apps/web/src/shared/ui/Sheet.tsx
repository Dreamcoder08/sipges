import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.tsx';
import styles from './Sheet.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])';
/** A drag past this distance, or a quick flick, dismisses the sheet. */
const DISMISS_DISTANCE = 96;
const DISMISS_VELOCITY = 0.6;
const isBottomSheet = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 60rem)').matches;

/**
 * Modal sheet (docs/adr/0015): rises from the bottom on phones and opens as a panel at the top
 * right on wide screens. With `side="start"` it is a drawer that slides in from the left edge
 * at full height on every width (the phone navigation drawer). While open, focus moves inside (the current link if there is one),
 * the rest of the page is inert and does not scroll; Escape, the backdrop, the close button and
 * (on phones) dragging the grabber down close it, and focus returns to whatever opened it.
 */
export const Sheet = ({
  open,
  onClose,
  title,
  side = 'bottom',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: 'bottom' | 'start';
  children: ReactNode;
}) => {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const own = container.current;
    const siblings = [...document.body.children].filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node !== own && !node.hasAttribute('inert'),
    );
    for (const node of siblings) node.setAttribute('inert', '');
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // The current link, else the first control of the content, else the close button.
    const target =
      panel.current?.querySelector<HTMLElement>('[aria-current="page"]') ??
      body.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      for (const node of siblings) node.removeAttribute('inert');
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const onGrab = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (side !== 'bottom' || !isBottomSheet() || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, t: event.timeStamp, dy: 0 };
    panel.current?.setAttribute('data-dragging', 'true');
  };
  const onDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panel.current) return;
    drag.current.dy = Math.max(0, event.clientY - drag.current.y);
    panel.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onRelease = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state || !panel.current) return;
    panel.current.removeAttribute('data-dragging');
    const velocity = state.dy / Math.max(1, event.timeStamp - state.t);
    if (state.dy > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY) closeRef.current();
    else panel.current.style.transform = '';
  };

  if (!open) return null;
  return createPortal(
    <div ref={container} className={styles.layer} data-side={side}>
      <div className={styles.backdrop} aria-hidden="true" onClick={() => closeRef.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.panel}
      >
        <div
          className={styles.grip}
          onPointerDown={onGrab}
          onPointerMove={onDrag}
          onPointerUp={onRelease}
          onPointerCancel={onRelease}
        >
          <span className={styles.handle} aria-hidden="true" />
          <div className={styles.header}>
            <h2 id={titleId}>{title}</h2>
            <button type="button" className={styles.close} onClick={() => closeRef.current()}>
              <Icon name="close" />
              <span className="visually-hidden">Cerrar</span>
            </button>
          </div>
        </div>
        <div ref={body} className={styles.body}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
};
