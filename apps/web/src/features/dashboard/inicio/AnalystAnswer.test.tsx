import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ApiError } from '../../../shared/api/client.ts';
import { AnalystAnswer } from './AnalystAnswer.tsx';

const answer = {
  answer: 'El bloqueo sigue [1]. La comunidad pide diálogo [2].',
  sources: [
    { n: 1, module: 'eventos', id: 'EV-1', title: 'Bloqueo de vía' },
    { n: 2, module: 'actores', id: 'A-7', title: '' },
  ],
};

it('shows progress, not an announcement, while the analyst works', () => {
  render(<AnalystAnswer pending question="¿Qué pasa?" onSearch={() => undefined} />);
  expect(screen.getByRole('progressbar', { name: 'Preparando la respuesta' })).toBeTruthy();
  expect(screen.queryByRole('status')?.textContent ?? '').toBe('');
});

it('announces the answer and links every citation to its source and record', () => {
  render(
    <AnalystAnswer
      pending={false}
      question="¿Qué pasa?"
      data={answer}
      onSearch={() => undefined}
    />,
  );
  const region = screen.getByRole('status');
  expect(region.textContent).toContain('El bloqueo sigue');
  const cite = within(region).getByRole('link', { name: 'Fuente 1: Bloqueo de vía' });
  expect(cite.getAttribute('href')).toBe('#analista-fuente-1');
  const list = screen.getByRole('list', { name: 'Fuentes citadas' });
  const first = within(list).getByRole('link', { name: /Bloqueo de vía/ });
  expect(first.getAttribute('href')).toBe('/objeto/eventos/EV-1');
  // A source without a title is named by its id.
  expect(within(list).getByRole('link', { name: /A-7/ }).getAttribute('href')).toBe(
    '/objeto/actores/A-7',
  );
});

it('offers the record search when the analyst is off for the project', () => {
  const onSearch = vi.fn();
  const off = new ApiError(409, 'El envío a IA externa está desactivado para este proyecto', null);
  render(
    <AnalystAnswer pending={false} question="bloqueo norte" error={off} onSearch={onSearch} />,
  );
  expect(screen.getByRole('alert').textContent).toContain('desactivado');
  fireEvent.click(screen.getByRole('button', { name: 'Buscar «bloqueo norte» en registros' }));
  expect(onSearch).toHaveBeenCalledWith('bloqueo norte');
});

it('shows the analyst failure as an alert with the server text', () => {
  const failed = new ApiError(
    502,
    'El analista no citó bien sus fuentes; vuelve a preguntar',
    null,
  );
  render(<AnalystAnswer pending={false} question="x" error={failed} onSearch={() => undefined} />);
  expect(screen.getByRole('alert').textContent).toContain('no citó bien sus fuentes');
});
