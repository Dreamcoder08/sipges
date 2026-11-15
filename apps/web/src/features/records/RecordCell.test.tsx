import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MODULES } from './modules.ts';
import { demandProgress, RecordCell } from './RecordCell.tsx';

const demandas = MODULES.demandas;
const field = (key: string) =>
  demandas.fields.find((item) => item.key === key) ?? { key, label: key };

describe('demandProgress', () => {
  it('derives the progress of a request from its status', () => {
    expect(demandas.fields.find((item) => item.key === 'Estado')?.options).toEqual([
      'Nueva',
      'En revisión',
      'En diálogo',
      'Atendida',
      'Cerrada',
    ]);
    expect(demandProgress('Nueva')).toBe(0);
    expect(demandProgress('En revisión')).toBe(25);
    expect(demandProgress('En diálogo')).toBe(50);
    expect(demandProgress('Atendida')).toBe(75);
    expect(demandProgress('Cerrada')).toBe(100);
    expect(demandProgress('Desconocido')).toBeUndefined();
  });
});

describe('RecordCell', () => {
  // functional-10 T1 (F1): lists show the shared date style, never the raw ISO day.
  it('shows a date field as the Lima day in Spanish and keeps the stored day for machines', () => {
    const { container } = render(
      <RecordCell
        module="demandas"
        row={{ _id: 'D-5', Fecha_Registro: '2026-11-14' }}
        field={field('Fecha_Registro')}
      />,
    );
    const time = container.querySelector('time');
    expect(time).toHaveAttribute('datetime', '2026-11-14');
    expect(container).toHaveTextContent('14 nov. 2026');
    expect(container).not.toHaveTextContent('2026-11-14');
  });

  it('shows the requests table columns in the tracking order', () => {
    expect(demandas.columns).toEqual([
      'Fecha_Registro',
      'Descripcion',
      'Actor/Grupo',
      'Prioridad',
      'Avance',
      'Estado',
    ]);
  });

  it('renders the derived progress as an accessible bar with its percentage', () => {
    render(
      <RecordCell
        module="demandas"
        row={{ _id: 'D-1', Estado: 'En revisión' }}
        field={field('Avance')}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Avance' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('25 %')).toBeInTheDocument();
  });

  it('shows a dash when the status has no known progress', () => {
    const { container } = render(
      <RecordCell module="demandas" row={{ _id: 'D-2', Estado: 'Otro' }} field={field('Avance')} />,
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(container).toHaveTextContent('—');
  });

  it('renders priority and status as labelled pills and plain fields as text', () => {
    const row = { _id: 'D-3', Prioridad: 'Alta', Estado: 'Nueva', 'Actor/Grupo': 'Ganaderos' };
    render(
      <>
        <RecordCell module="demandas" row={row} field={field('Prioridad')} />
        <RecordCell module="demandas" row={row} field={field('Estado')} />
        <RecordCell module="demandas" row={row} field={field('Actor/Grupo')} />
      </>,
    );
    expect(screen.getByText('Alta')).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByText('Nueva')).toHaveAttribute('data-tone', 'info');
    expect(screen.getByText('Ganaderos')).not.toHaveAttribute('data-tone');
  });

  it('keeps an empty priority as a dash instead of an empty pill', () => {
    const { container } = render(
      <RecordCell module="demandas" row={{ _id: 'D-4' }} field={field('Prioridad')} />,
    );
    expect(container).toHaveTextContent('—');
    expect(container.querySelector('[data-tone]')).toBeNull();
  });
});
