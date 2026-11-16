import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RecordDetail } from './RecordDetail.tsx';

// functional-10 T16 (ego-browser walk): a record created through the API keeps its own id key and
// fields the module form does not declare; the sheet names them in words, never as stored keys.
const alert = {
  _id: 'AL-1',
  ID_Alerta: 'AL-1',
  Fecha: '2026-11-13',
  Causa: 'Alerta sintética',
  Dimension: 'G',
  'Evento/Registro_Origen': 'EV-2',
};

it('names the other fields in words and does not repeat the record code', () => {
  render(<RecordDetail module="alertas" record={alert} />);
  const extras = screen.getByRole('region', { name: 'Otros datos del registro' });
  const terms = within(extras)
    .getAllByRole('term')
    .map((node) => node.textContent);
  expect(terms).toEqual(['Evento / registro origen']);
  expect(within(extras).getByText('EV-2')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/[A-Za-z]+_[A-Za-z]+/);
});

it('names the dimension beside its letter', () => {
  render(<RecordDetail module="alertas" record={alert} />);
  expect(screen.getByText('G · Gobernanza')).toBeInTheDocument();
});
