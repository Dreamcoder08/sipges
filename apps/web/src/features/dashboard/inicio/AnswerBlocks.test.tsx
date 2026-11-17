import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { AnalystBlock } from './ask.ts';
import { AnswerBlocks } from './AnswerBlocks.tsx';

const record = { n: 1, module: 'eventos', id: 'EV-1', title: 'Bloqueo de vía' };

const one = (block: AnalystBlock) => {
  render(<AnswerBlocks blocks={[block]} />);
  return screen.getByRole('list', { name: 'Detalles de la respuesta' });
};

it('draws a record card that links to the record', () => {
  const list = one({ type: 'record', ...record });
  const card = within(list).getByRole('article', { name: 'Bloqueo de vía' });
  expect(within(card).getByRole('link', { name: 'Bloqueo de vía' }).getAttribute('href')).toBe(
    '/objeto/eventos/EV-1',
  );
  expect(card.textContent).toContain('eventos · EV-1');
});

it('draws an alert card with the text as text, never as markup', () => {
  const list = one({ type: 'alert', ...record, text: '<b>Paro</b> anunciado' });
  const alert = within(list).getByRole('status');
  expect(alert.textContent).toContain('<b>Paro</b> anunciado');
  expect(alert.querySelector('b')).toBeNull();
  expect(within(alert).getByRole('link', { name: 'Bloqueo de vía' }).getAttribute('href')).toBe(
    '/objeto/eventos/EV-1',
  );
});

it('draws a map focus as links to the map and to the record', () => {
  const list = one({ type: 'map', ...record });
  const card = within(list).getByRole('article', { name: 'Bloqueo de vía en el mapa' });
  expect(
    within(card).getByRole('link', { name: 'Abrir el mapa territorial' }).getAttribute('href'),
  ).toBe('/mapa');
  expect(within(card).getByRole('link', { name: 'Bloqueo de vía' }).getAttribute('href')).toBe(
    '/objeto/eventos/EV-1',
  );
});

it('draws a timeline excerpt with its dated events in order', () => {
  const list = one({
    type: 'timeline',
    ...record,
    entries: [
      { date: '2026-03-02', text: 'Inicio del bloqueo' },
      { date: '2026-03-05', text: 'Mesa de diálogo' },
    ],
  });
  const card = within(list).getByRole('article', { name: 'Cronología de Bloqueo de vía' });
  const events = within(card).getAllByRole('listitem');
  expect(events.map((e) => e.textContent)).toEqual([
    expect.stringContaining('Inicio del bloqueo'),
    expect.stringContaining('Mesa de diálogo'),
  ]);
  expect(events[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-03-02');
});

it('draws nothing without blocks', () => {
  const { container } = render(<AnswerBlocks blocks={[]} />);
  expect(container.textContent).toBe('');
});
