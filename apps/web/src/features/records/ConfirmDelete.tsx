import { useEffect, useId, useRef } from 'react';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './Records.module.css';

export const ConfirmDelete = ({
  id,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  id: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const title = useId();
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
        aria-labelledby={title}
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
        <h2 id={title}>Eliminar registro</h2>
        <p id={description}>
          Se eliminará el registro {id} y sus vínculos de evidencia. Esta acción no se puede
          deshacer.
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className={styles.actions}>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {pending ? 'Eliminando…' : 'Confirmar eliminación'}
          </Button>
        </div>
      </div>
    </div>
  );
};
