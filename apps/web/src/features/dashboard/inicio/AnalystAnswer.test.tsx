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

it('links every citation to its source in this answer and each source to its record', () => {
  render(<AnalystAnswer question="¿Qué pasa?" data={answer} onSearch={() => undefined} />);
  const region = screen.getByRole('region', { name: 'Respuesta del analista' });
  expect(region.textContent).toContain('El bloqueo sigue');
  // The conversation log reads the answer; the answer holds no live region of its own (T5).
  expect(within(region).queryByRole('status')).toBeNull();
  const cite = within(region).getByRole('link', { name: 'Fuente 1: Bloqueo de vía' });
  const list = screen.getByRole('list', { name: 'Fuentes citadas' });
  // Per answer, so two answers on one page never share an anchor.
  const target = document.getElementById(cite.getAttribute('href')?.slice(1) ?? '');
  expect(target?.parentElement).toBe(list);
  expect(target).toHaveTextContent('Bloqueo de vía');
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
  render(<AnalystAnswer question="bloqueo norte" error={off} onSearch={onSearch} />);
  expect(screen.getByText(/desactivado/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Buscar «bloqueo norte» en registros' }));
  expect(onSearch).toHaveBeenCalledWith('bloqueo norte');
});

it('shows the analyst failure with the server text, without an alert role', () => {
  const failed = new ApiError(
    502,
    'El analista no citó bien sus fuentes; vuelve a preguntar',
    null,
  );
  render(<AnalystAnswer question="x" error={failed} onSearch={() => undefined} />);
  expect(screen.getByText(/no citó bien sus fuentes/)).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('draws the typed blocks after the answer and its sources', () => {
  render(
    <AnalystAnswer
      question="¿Qué pasa?"
      data={{
        ...answer,
        blocks: [{ type: 'record', n: 1, module: 'eventos', id: 'EV-1', title: 'Bloqueo de vía' }],
      }}
      onSearch={() => undefined}
    />,
  );
  const blocks = screen.getByRole('list', { name: 'Detalles de la respuesta' });
  expect(within(blocks).getByRole('article', { name: 'Bloqueo de vía' })).toBeTruthy();
});
