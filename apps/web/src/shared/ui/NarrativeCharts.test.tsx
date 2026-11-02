import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NarrativeCharts } from './NarrativeCharts.tsx';

const rows = [
  { _id: '1', Fecha_Inicio: '15 oct 2026', Tema: 'Contaminación del agua' },
  { _id: '2', Fecha_Inicio: '15/10/2026', Tema: 'Junta directiva comunal' },
  { _id: '3', Tema: 'Publicación viral' },
];

it('shows totals per category instead of the trend with fewer than two dated days', () => {
  render(<NarrativeCharts rows={rows} window={30} />);
  expect(screen.queryByRole('table', { name: /por día y categoría/ })).toBeNull();
  expect(screen.getByText('Medio ambiente')).toBeInTheDocument();
  expect(screen.getByText('Gobernanza')).toBeInTheDocument();
  expect(screen.getByText(/al menos dos días distintos/)).toBeInTheDocument();
  expect(screen.getByText(/1 narrativa\(s\) sin fecha utilizable/)).toBeInTheDocument();
});

it('compact view leaves out the «Por día» heading when there is no trend to draw', () => {
  render(<NarrativeCharts rows={rows} window={90} compact />);
  expect(screen.getByRole('heading', { name: 'Por categoría' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Por día' })).toBeNull();
});

it('compact view draws the trend under the categories with two or more dated days', () => {
  render(
    <NarrativeCharts
      rows={[...rows, { _id: '4', Fecha_Inicio: '2026-10-17', Tema: 'agua' }]}
      window={90}
      compact
    />,
  );
  expect(screen.getByRole('heading', { name: 'Por día' })).toBeInTheDocument();
  expect(screen.getByRole('table', { name: /por día y categoría/ })).toBeInTheDocument();
});
