import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.tsx';
import styles from './Sheet.module.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled])';

/**
 * Modal sheet (docs/adr/0015): rises from the bottom on phones and opens as a panel at the top
 * right on wide screens. While open, focus moves inside (the current link if there is one),
 * the rest of the page is inert and does not scroll; Escape, the backdrop and the close button
 * close it and focus returns to whatever opened it.
 */
export const Sheet = ({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
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

  if (!open) return null;
  return createPortal(
    <div ref={container} className={styles.layer}>
      <div className={styles.backdrop} aria-hidden="true" onClick={() => closeRef.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.panel}
      >
        <span className={styles.handle} aria-hidden="true" />
        <div className={styles.header}>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className={styles.close} onClick={() => closeRef.current()}>
            <Icon name="close" />
            <span className="visually-hidden">Cerrar</span>
          </button>
        </div>
        <div ref={body} className={styles.body}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
};
