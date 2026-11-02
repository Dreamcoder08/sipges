import { type ReactNode, useRef, useState } from 'react';
import { Alert } from './Alert.tsx';
import { Button } from './Button.tsx';
import styles from './ConfirmDialog.module.css';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog.tsx';

const keepOpen = (event: Event) => event.preventDefault();

/**
 * Modal confirmation for an action that cannot be undone, on the shared Radix dialog with
 * alert-dialog rules: focus starts on «Cancelar», stays inside and returns to the trigger on
 * close; the rest of the page is hidden from assistive technology; Escape cancels unless the
 * action is pending, and clicking the backdrop never dismisses it.
 */
export const ConfirmDialog = ({
  title,
  children,
  confirmLabel,
  pendingLabel,
  pending,
  confirmDisabled = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  /** Keeps «Cancelar» usable while the action cannot run yet (for example, a preview loads). */
  confirmDisabled?: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const cancel = useRef<HTMLButtonElement>(null);
  // Consumers open the dialog from their own buttons, not a Radix trigger, so remember the
  // opener before Radix moves focus and hand focus back to it on close.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent
        role="alertdialog"
        className={styles.dialog}
        overlayClassName={styles.backdrop}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener?.isConnected) opener.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={keepOpen}
        onInteractOutside={keepOpen}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{children}</DialogDescription>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className={styles.actions}>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button disabled={pending || confirmDisabled} onClick={onConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
