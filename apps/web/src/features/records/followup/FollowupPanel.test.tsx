import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import * as panel from './FollowupPanel.tsx';

afterEach(() => vi.useRealTimers());

it('filters deadlines, preserves free text and opens the original record with a return target', async () => {
  expect(panel.FollowupPanel).toBeTypeOf('function');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'));
  const user = userEvent.setup();
  const open = vi.fn();
  render(
    <panel.FollowupPanel
      module="compromisos"
      onOpen={open}
      rows={[
        { _id: 'C-1', Descripcion: 'Instalar equipos', Estado: 'Incumplido', Plazo: '2026-10-13' },
        {
          _id: 'C-2',
          Descripcion: 'Sesión pública',
          Plazo: 'Tras la reunión',
          Responsable: 'Equipo',
        },
        { _id: 'C-3', Descripcion: 'Entrega', Plazo: '2026-10-14', Estado: 'Pendiente' },
        { _id: 'C-4', Descripcion: 'Cerrado', Plazo: '2026-10-13', Estado: 'Cumplido' },
      ]}
    />,
  );
  expect(screen.getByText(/2026-10-14.*America\/Lima/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Vencidos: 1' }));
  expect(screen.queryByText('Sesión pública')).not.toBeInTheDocument();
  const button = screen.getByRole('button', { name: 'Abrir compromiso C-1' });
  expect(button).toHaveAttribute('data-return', 'insight-C-1');
  await user.click(button);
  expect(open).toHaveBeenCalledWith('C-1');
  await user.click(screen.getByRole('button', { name: 'Sin fecha válida: 1' }));
  expect(screen.getByText('Plazo: Tras la reunión')).toBeInTheDocument();
  expect(screen.queryByText('Instalar equipos')).not.toBeInTheDocument();
});

it('shows textual Plazo alongside an invalid explicit deadline', () => {
  render(
    <panel.FollowupPanel
      module="acciones"
      onOpen={() => {}}
      rows={[
        {
          _id: 'A-1',
          Accion: 'Revisión',
          Fecha_Vencimiento: '2026-02-30',
          Plazo: 'Después del taller',
        },
      ]}
    />,
  );
  expect(screen.getByText('Plazo original: Después del taller')).toBeInTheDocument();
});

it('shows cleared deadlines as unregistered while keeping original textual Plazo separate', () => {
  render(
    <panel.FollowupPanel
      module="acciones"
      onOpen={() => {}}
      rows={[
        {
          _id: 'A-2',
          Accion: 'Coordinación',
          Fecha_Vencimiento: '',
          Fecha_Limite: '2020-01-02',
          Plazo: 'Después del taller',
        },
      ]}
    />,
  );
  expect(screen.getByText('Plazo: Sin registrar')).toBeInTheDocument();
  expect(screen.queryByText(/2020-01-02/)).not.toBeInTheDocument();
  expect(screen.getByText('Plazo original: Después del taller')).toBeInTheDocument();
});
