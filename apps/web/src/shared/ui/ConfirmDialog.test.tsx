import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.tsx';

const Harness = ({
  pending = false,
  onConfirm = () => undefined,
}: {
  pending?: boolean;
  onConfirm?: () => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Eliminar
        </button>
      </main>
      {open ? (
        <ConfirmDialog
          title="Eliminar registro"
          confirmLabel="Confirmar eliminación"
          pendingLabel="Eliminando…"
          pending={pending}
          error={null}
          onConfirm={onConfirm}
          onCancel={() => setOpen(false)}
        >
          Esta acción no se puede deshacer.
        </ConfirmDialog>
      ) : null}
    </>
  );
};

const openDialog = async (props: Parameters<typeof Harness>[0] = {}) => {
  const user = userEvent.setup();
  render(<Harness {...props} />);
  const trigger = screen.getByRole('button', { name: 'Eliminar' });
  await user.click(trigger);
  const dialog = screen.getByRole('alertdialog', { name: 'Eliminar registro' });
  return { user, trigger, dialog };
};

it('is a described alert dialog that starts focus on «Cancelar»', async () => {
  const { dialog } = await openDialog();
  expect(dialog).toHaveAccessibleDescription('Esta acción no se puede deshacer.');
  expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
});

it('keeps Tab inside the dialog in both directions', async () => {
  const { user } = await openDialog();
  const cancel = screen.getByRole('button', { name: 'Cancelar' });
  const confirm = screen.getByRole('button', { name: 'Confirmar eliminación' });
  await user.tab();
  expect(confirm).toHaveFocus();
  await user.tab();
  expect(cancel).toHaveFocus();
  await user.tab({ shift: true });
  expect(confirm).toHaveFocus();
});

it('cancels on Escape and returns focus to the trigger', async () => {
  const { user, trigger } = await openDialog();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  // Radix restores focus on the next tick after unmounting.
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('ignores Escape while the action is pending', async () => {
  const { user } = await openDialog({ pending: true });
  await user.keyboard('{Escape}');
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Eliminando…' })).toBeDisabled();
});

it('confirms only through its confirm button', async () => {
  const onConfirm = vi.fn();
  const { user } = await openDialog({ onConfirm });
  await user.click(screen.getByRole('button', { name: 'Confirmar eliminación' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it('hides the rest of the page from assistive technology while open', async () => {
  const { user } = await openDialog();
  // Only the dialog's own controls remain in the accessibility tree.
  expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Cancelar',
    'Confirmar eliminación',
  ]);
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Eliminar' })).toBeInTheDocument();
});

it('does not cancel when the backdrop is clicked', async () => {
  const { user } = await openDialog();
  const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
  expect(overlay).not.toBeNull();
  if (overlay) await user.click(overlay);
  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
});

it('does not inject style elements under the strict CSP', async () => {
  const before = document.querySelectorAll('style').length;
  await openDialog();
  expect(document.querySelectorAll('style')).toHaveLength(before);
});
