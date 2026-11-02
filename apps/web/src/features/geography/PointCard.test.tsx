import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PointCard } from './PointCard.tsx';
import type { MapPoint } from './territorial-model.ts';

// Synthetic record placed in an invented locality.
const point: MapPoint = {
  id: 'D-1',
  layer: 'Demandas',
  dimension: 'D',
  title: 'Agua para riego',
  date: '2026-10-20',
  territory: 'Pampa Alta',
  locality: 'Pampa Alta',
  at: [-80.4, -4.9],
  level: 'Amarillo',
  actor: '',
  status: 'Nueva',
  evidence: 'observado',
  evidenceBasis: 'Registro de campo',
  source: '',
  verification: '',
  precision: 'localidad',
};

it("links the record's locality to its conflict-risk prediction", () => {
  render(<PointCard point={point} onClose={() => undefined} />);
  expect(screen.getByRole('link', { name: /Riesgo de conflicto de Pampa Alta/ })).toHaveAttribute(
    'href',
    '/analisis?vista=riesgo&localidad=Pampa%20Alta',
  );
});

it('offers no conflict-risk link when the record has no locality', () => {
  render(<PointCard point={{ ...point, locality: '' }} onClose={() => undefined} />);
  expect(screen.queryByRole('link', { name: /Riesgo de conflicto/ })).toBeNull();
});
