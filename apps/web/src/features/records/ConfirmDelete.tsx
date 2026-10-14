import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.tsx';

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
}) => (
  <ConfirmDialog
    title="Eliminar registro"
    confirmLabel="Confirmar eliminación"
    pendingLabel="Eliminando…"
    pending={pending}
    error={error}
    onConfirm={onConfirm}
    onCancel={onCancel}
  >
    Se eliminará el registro {id} y sus vínculos de evidencia. Esta acción no se puede deshacer.
  </ConfirmDialog>
);
