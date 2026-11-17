import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { Composer, type ComposerMode } from './Composer.tsx';

/* The chat composer (odd/tasks/chat-first-ui.md T3): one test per rule, through roles and labels. */

type Props = ComponentProps<typeof Composer>;

/** Holds the text and the mode the way a page does, so the composer is driven as in Inicio. */
const Harness = ({
  initialMode = 'preguntar',
  ...props
}: Partial<Props> & { initialMode?: ComposerMode }) => {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<ComposerMode>(initialMode);
  return (
    <Composer
      label="Pregunta"
      placeholder="Escribe tu pregunta…"
      hint="Enter pregunta · Mayús+Enter, nueva línea"
      sendLabel="Enviar pregunta"
      value={value}
      onValueChange={setValue}
      mode={mode}
      onModeChange={setMode}
      onSubmit={() => {}}
      {...props}
    />
  );
};

const field = () => screen.getByRole('textbox', { name: 'Pregunta' });
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });

it('submits the trimmed text with Enter, keeps Shift+Enter and an empty box from sending', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Harness onSubmit={onSubmit} />);
  await user.type(field(), '   {Enter}');
  expect(onSubmit).not.toHaveBeenCalled();
  await user.type(field(), 'agua{Shift>}{Enter}{/Shift}norte');
  expect(onSubmit).not.toHaveBeenCalled();
  await user.type(field(), '{Enter}');
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith('agua\nnorte');
  expect(field()).toHaveAccessibleDescription('Enter pregunta · Mayús+Enter, nueva línea');
});

it('does not send the Enter that confirms an input method candidate', () => {
  const onSubmit = vi.fn();
  render(<Harness onSubmit={onSubmit} />);
  type('agua');
  // Chromium and Firefox flag the confirming Enter as composing; Safari reports keyCode 229.
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(fireEvent.keyDown(field(), { key: 'Enter', ...init })).toBe(false);
  }
  expect(onSubmit).not.toHaveBeenCalled();
  expect(field()).toHaveValue('agua');
});

it('grows one row per line up to 8 rows, then scrolls', () => {
  render(<Harness />);
  expect(field()).toHaveAttribute('rows', '2');
  type(['1', '2', '3', '4', '5'].join('\n'));
  expect(field()).toHaveAttribute('rows', '5');
  type(Array.from({ length: 12 }, (_, line) => `línea ${line + 1}`).join('\n'));
  expect(field()).toHaveAttribute('rows', '8');
});

it('switches between «Buscar» and «Preguntar» in one radio group inside the composer', async () => {
  const user = userEvent.setup();
  const onModeChange = vi.fn();
  const { rerender } = render(<Harness onModeChange={onModeChange} />);
  const modes = screen.getByRole('group', { name: 'Modo' });
  expect(within(modes).getByRole('radio', { name: 'Preguntar' })).toBeChecked();
  await user.click(within(modes).getByRole('radio', { name: 'Buscar' }));
  expect(onModeChange).toHaveBeenCalledExactlyOnceWith('buscar');

  // Without external AI or an analyst, «Preguntar» stays visible, disabled, and says why.
  const reason = 'Preguntar no está disponible: la IA externa está desactivada en este proyecto.';
  rerender(<Harness initialMode="buscar" mode="buscar" askUnavailable={reason} />);
  const ask = within(modes).getByRole('radio', { name: 'Preguntar' });
  expect(ask).toBeDisabled();
  expect(ask).toHaveAccessibleDescription(reason);
  expect(within(modes).getByRole('radio', { name: 'Buscar' })).toBeChecked();
});

it('turns the send button into «Detener respuesta» in the same place while pending', async () => {
  const user = userEvent.setup();
  const onStop = vi.fn();
  const onSubmit = vi.fn();
  const { rerender } = render(<Harness onStop={onStop} onSubmit={onSubmit} />);
  const send = screen.getByRole('button', { name: 'Enviar pregunta' });
  rerender(<Harness onStop={onStop} onSubmit={onSubmit} pending />);
  const stop = screen.getByRole('button', { name: 'Detener respuesta' });
  expect(stop).toBe(send);
  expect(screen.queryByRole('button', { name: 'Enviar pregunta' })).toBeNull();
  await user.click(stop);
  expect(onStop).toHaveBeenCalledOnce();
  // While pending, Enter does not send a second question.
  await user.type(field(), 'otra{Enter}');
  expect(onSubmit).not.toHaveBeenCalled();
});

it('clears with Esc, and stops instead while an answer is pending', async () => {
  const user = userEvent.setup();
  const onStop = vi.fn();
  const { rerender } = render(<Harness onStop={onStop} />);
  await user.type(field(), 'bloqueo{Escape}');
  expect(field()).toHaveValue('');
  expect(onStop).not.toHaveBeenCalled();
  rerender(<Harness onStop={onStop} pending />);
  await user.type(field(), 'agua{Escape}');
  expect(onStop).toHaveBeenCalledOnce();
  expect(field()).toHaveValue('agua');
});

it('recalls the last question with ↑ in an empty composer only', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.type(field(), '  agua del valle  {Enter}{Escape}');
  expect(field()).toHaveValue('');
  await user.keyboard('{ArrowUp}');
  expect(field()).toHaveValue('agua del valle');
  await user.clear(field());
  await user.type(field(), 'otra{ArrowUp}');
  expect(field()).toHaveValue('otra');
});

it('counts from 450 of the 500 characters and says when the limit is reached', () => {
  render(<Harness />);
  expect(field()).toHaveAttribute('maxlength', '500');
  type('a'.repeat(449));
  expect(screen.queryByText(/\/500/)).toBeNull();
  type('a'.repeat(450));
  expect(screen.getByText('450/500')).toBeVisible();
  expect(field()).toHaveAccessibleDescription(/450\/500/);
  type('a'.repeat(500));
  expect(screen.getByText('500/500 · Llegaste al límite')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Llegaste al límite de 500 caracteres.');
});
