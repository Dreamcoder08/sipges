import { useEffect, useId, useRef } from 'react';
import { Button } from '../../shared/ui/Button.tsx';
import styles from './IdleWarningDialog.module.css';

/**
 * The idle warning: a native modal dialog, so the page behind is inert and Escape closes it.
 * Any close, the button or Escape, means the person continues. React does not render
 * `autofocus`, so the button takes focus right after `showModal()`.
 */
export const IdleWarningDialog = ({ onStay }: { onStay: () => void }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    element.showModal();
    button.current?.focus();
  }, []);
  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onStay}>
      <h2 id={titleId}>Su sesión está por cerrarse</h2>
      <p>Por inactividad, la sesión se cerrará en 2 minutos. Lo que no haya guardado se perderá.</p>
      <form method="dialog" className={styles.actions}>
        <Button ref={button} type="submit">
          Seguir conectado
        </Button>
      </form>
    </dialog>
  );
};
