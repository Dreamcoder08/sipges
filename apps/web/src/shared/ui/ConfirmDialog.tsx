import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Alert } from './Alert.tsx';
import { Button } from './Button.tsx';
import styles from './ConfirmDialog.module.css';

/**
 * Modal confirmation for an action that cannot be undone: focus starts on «Cancelar», Tab stays
 * inside, Escape cancels and focus returns to the trigger on close.
 */
export const ConfirmDialog = ({
  title,
  children,
  confirmLabel,
  pendingLabel,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const description = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className={styles.backdrop}>
      <div
        ref={ref}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !pending) {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const buttons =
              ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            const first = buttons?.[0];
            const last = buttons?.[buttons.length - 1];
            if (!first || !last) {
              event.preventDefault();
              return;
            }
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={description}>{children}</p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className={styles.actions}>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};
